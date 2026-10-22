import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createI18nTestContext, translate } from './helpers/i18n.ts';
import { agentTaskErrorKey } from '../apps/web/src/agent-task-errors.ts';
import * as presentation from '../apps/web/src/agent-task-presentation.ts';
import { message } from '../packages/i18n/src/index.ts';
import {agentTaskNewConversationBlock} from '../apps/web/src/agent-tasks-v2.ts';
import {AGENT_TASK_STATUSES} from '../packages/contracts/src/agent-tasks-v2.ts';
const nodes=value=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const source=readFileSync(new URL('../apps/web/src/AgentTaskPanel.tsx',import.meta.url),'utf8');
const projectId='11111111-1111-4111-8111-111111111111',stepId='22222222-2222-4222-8222-222222222222';
function harness({backgroundPending=false,readOnly=false,status,changes=[],locale='zh-Hans'}={}){
  let currentLocale=locale;
  const hooks=[];let cursor=0,pending=[],tree,loads=0;const calls=[];
  const react={createElement:(type,props,...children)=>({type,props:{...props,children:type==='dialog'&&!props.open?[]:type==='dialog-content'?[...children,props.footer]:type==='retained'?[...children,props.recovery]:children}}),Fragment:'fragment',useRef:value=>hooks[cursor++]??={current:value},useState:value=>{const index=cursor++;hooks[index]??={value};return[hooks[index].value,next=>{hooks[index].value=typeof next==='function'?next(hooks[index].value):next;}];},useLayoutEffect:(fn,deps)=>{const index=cursor++,old=hooks[index];if(!old||deps.some((value,at)=>value!==old.deps[at])){hooks[index]={...old,fn,deps};pending.push(index);}}};react.default=react;
  const snapshot={run:{id:'run',projectId,text:'synthetic task',status:status??(backgroundPending?'completed':'awaiting_approval'),stepsUsed:2,budget:30,configuration:{model:'historical-model'}},steps:[{id:stepId,kind:'tool',status:'completed',approvalRequired:true,tier:'paid',toolCall:{name:'mioon_generation_submit',arguments:{}}}],changes,backgroundPending};
  const state={phase:'ready',project:{readOnly,runs:[snapshot.run],authorization:{scopes:['project_agent']},settings:{configuration:{model:'current-model'}}},snapshot,draft:'next task',uploads:[],pending:null,error:'',conversationId:'run',conversation:{id:'run',title:'synthetic task'},rounds:[snapshot],selectionKey:'run',legacy:false,draftDirty:true,draftVersion:0,unknownOutcome:false,history:{conversations:[{id:'run',title:'synthetic task'}],nextCursor:null,phase:'ready'}};
  const module={exports:{}};let options;
  const previous=globalThis.document;globalThis.document={visibilityState:'visible',addEventListener(){},removeEventListener(){}};
  Function('module','exports','require',transformSync(source,{loader:'tsx',format:'cjs'}).code)(module,module.exports,id=>{
    if(id==='react')return react;if(id==='./agent-task-presentation.ts')return presentation;if(id.includes('packages/i18n/src/index.ts'))return{message};if(id.includes('workbench-confirm'))return{useConfirmation:()=>async()=>true};if(id.includes('workbench-controls'))return{WorkbenchButton:'button',WorkbenchDialogContent:'dialog-content'};if(id.includes('/dialog'))return{Dialog:'dialog'};if(id.includes('workbench-tooltip'))return{WorkbenchTooltip:'tooltip'};if(id.includes('workbench-popover'))return{WorkbenchPopover:'popover',WorkbenchPopoverContent:'popover-content',WorkbenchPopoverTrigger:'popover-trigger'};if(id==='./AgentRetainedEditing.tsx')return{__esModule:true,default:'retained'};if(id.includes('I18nProvider'))return{useI18n:()=>createI18nTestContext(currentLocale)};if(id==='./agent-task-errors.ts')return{agentTaskErrorKey};if(id.includes('workspace-visibility'))return{useWorkspaceVisibility:()=>true};if(id==='./AgentConversationHistory.tsx')return{__esModule:true,default:'conversation-history'};if(id==='./agent-tasks-v2.ts')return{agentTaskNewConversationBlock,createAgentTaskReceiptStore:()=>({}),agentTaskPromptValid:()=>true,createAgentTaskSession:value=>{options=value;return{getState:()=>state,load(){loads++;value.onChange(state);},setVisible(){},dispose(){},cancelSelection(){},action:(...args)=>calls.push(args),send:async()=>{calls.push(['send']);return true;},authorizationReview:()=>({projectId,settingsRevision:1,authorizationRevision:1,destination:'https://example.invalid/v1/responses',model:'current-model',text:state.draft,uploads:state.uploads.map(item=>item.id),locale:currentLocale}),authorizeAndSend:async value=>{calls.push(['authorizeAndSend',value]);return true;},edit:value=>{state.draft=value;calls.push(['edit',value]);},removeUpload:id=>{state.uploads=state.uploads.filter(item=>item.id!==id);},history(){calls.push(['history']);},selectConversation:async(...args)=>{calls.push(['selectConversation',...args]);return true;},newConversation:()=>{calls.push(['newConversation']);return true;}};}};
    if(id.includes('native-close-sources'))return{createAgentTaskCloseReporter:()=>({publish(){},release(){}})};if(id.includes('agent-settings.ts'))return{deriveAgentEndpoint:()=>'/synthetic'};if(id.includes('/button'))return{Button:'button'};if(id.includes('/textarea'))return{Textarea:'textarea'};if(id.includes('/input'))return{Input:'input'};if(id.includes('/badge'))return{Badge:'badge'};return{__esModule:true,default:'placeholder'};
  });
  const render=()=>{cursor=0;pending=[];tree=module.exports.default({projectId,onSettings(page){calls.push(page ? ['settings',page] : ['settings']);},onClose(){}});for(const index of pending){hooks[index].cleanup?.();hooks[index].cleanup=hooks[index].fn();}return nodes(tree);};render();
  return{render,calls,state,setLocale(value){currentLocale=value;},get options(){return options;},get loads(){return loads;},find:id=>nodes(tree).find(node=>node.props?.['data-testid']===id),unmount(){for(const hook of hooks)hook.cleanup?.();globalThis.document=previous;}};
}
test('a read-only load error keeps its reload action visible and cannot send without a verified project',()=>{
  const h=harness();try{h.state.phase='read_error';h.state.error='NETWORK';h.state.project=null;h.state.snapshot=null;h.state.draft='';h.render();assert.ok(h.find('agent-task-error'));const reload=h.find('agent-task-reload');assert.ok(reload);assert.equal(reload.props.disabled,false);assert.equal(h.find('agent-task-send').props.disabled,true);const loads=h.loads;reload.props.onClick();assert.equal(h.loads,loads+1);assert.deepEqual(h.calls,[]);}finally{h.unmount();}
});
test('a saved step failure is localized by code beside its unknown-result controls',()=>{
  const h=harness();try{const step=h.state.snapshot.steps[0];step.kind='model';step.status='unknown';step.error={code:'AGENT_CHAT_HTTP_ERROR',message:'模型服务拒绝了请求（HTTP 401）。'};h.render();const error=h.find(`agent-task-step-error-${stepId}`);assert.ok(error);assert.equal(error.props.role,'alert');assert.deepEqual(error.props.children,[translate('zh-Hans',agentTaskErrorKey(step.error.code))]);assert.notEqual(error.props.children[0],step.error.message);assert.equal(error.props.dangerouslySetInnerHTML,undefined);}finally{h.unmount();}
});

test('Mio localizes step, run and transport errors without rendering diagnostic messages',()=>{
  for(const locale of ['zh-Hans','zh-Hant','en','ja']){
    const h=harness({locale,status:'failed'});
    try{
      h.state.snapshot.run.pauseReason='AGENT_CHAT_TIMEOUT';
      h.state.snapshot.steps[0].error={code:'AGENT_CHAT_HTTP_ERROR',message:'diagnostic <b>untrusted text</b>'};
      h.state.error='AGENT_TASK_CONSENT_REQUIRED';h.render();
      assert.deepEqual(h.find(`agent-task-step-error-${stepId}`).props.children,[translate(locale,agentTaskErrorKey('AGENT_CHAT_HTTP_ERROR'))]);
      assert.ok(h.find('agent-task-run-error').props.children.includes(translate(locale,agentTaskErrorKey('AGENT_CHAT_TIMEOUT'))));
      assert.deepEqual(h.find('agent-task-error').props.children,[translate(locale,agentTaskErrorKey('AGENT_TASK_CONSENT_REQUIRED'))]);
      h.state.snapshot.steps[0].error.code='UNRECOGNIZED';h.render();
      assert.deepEqual(h.find(`agent-task-step-error-${stepId}`).props.children,[translate(locale,agentTaskErrorKey(undefined))]);
    }finally{h.unmount();}
  }
});

test('preparing has no step budget and a locale change retains the panel session and draft',()=>{
  const h=harness({status:'accepted',locale:'zh-Hans'});
  try{
    h.render();const options=h.options;const loads=h.loads;
    assert.equal(options.getLocale(),'zh-Hans');
    assert.equal(JSON.stringify(h.find('agent-task-status')).includes(translate('zh-Hans','agent.task.budget',{used:2,limit:30})),false);
    h.setLocale('ja');h.render();
    assert.equal(h.options,options);assert.equal(h.loads,loads);
    assert.equal(options.getLocale(),'ja');assert.equal(h.state.draft,'next task');
    assert.deepEqual(nodes(h.find('agent-task-status')).find(node=>node.type==='strong').props.children,[translate('ja','agent.task.status.accepted')]);
  }finally{h.unmount();}
});
test('an already accepted generation with renewed approval requirement renders the same exact-step approval card',()=>{
  const h=harness();try{h.render();assert.ok(h.find(`agent-task-approval-${stepId}`));h.find(`agent-task-approve-${stepId}`).props.onClick();assert.deepEqual(h.calls[0],['approve',{stepId},'run']);const card=h.find(`agent-task-approval-${stepId}`),buttons=nodes(card).filter(node=>node.type==='button');assert.equal(buttons.length,3);h.find(`agent-task-deny-${stepId}`).props.onClick();assert.deepEqual(h.calls[1],['deny',{stepId},'run']);buttons.at(-1).props.onClick();assert.deepEqual(h.calls[2],['settings']);}finally{h.unmount();}
});
test('unfinished background work blocks another send while retaining pause/stop controls and read-only history selection',()=>{
  const h=harness({backgroundPending:true});try{h.render();assert.ok(h.find('agent-task-background-pending'));assert.ok(h.find('agent-task-pause'));assert.ok(h.find('agent-task-stop'));assert.equal(h.find('agent-task-send').props.disabled,true);assert.equal(h.find('agent-task-new-conversation').props.disabled,true);const upload=h.find('agent-task-upload');assert.equal(upload.type,'input');assert.equal(upload.props.type,'file');assert.equal(upload.props.disabled,false);}finally{h.unmount();}
  const restored=harness({readOnly:true});try{const tree=restored.render();assert.ok(restored.find('agent-task-read-only'));const history=tree.find(node=>node.type==='conversation-history');assert.equal(history.props.disabled,false);assert.equal(restored.find('agent-task-send'),undefined);assert.equal(restored.find('agent-task-stop').props.disabled,true);assert.equal(restored.find('agent-task-upload'),undefined);}finally{restored.unmount();}
});

test('undo controls allow only safely finished runs and remain disabled through pause, approval and interruption',async()=>{
  const changes=[{id:'change',summary:'local edit',operation:'shot.update',targets:[],reversible:true,status:'applied'}];
  for(const status of ['running','paused','awaiting_approval','interrupted','completed','failed','stopped']){
    const h=harness({status,changes});try{h.render();const allowed=['completed','failed','stopped'].includes(status);assert.equal(h.find('agent-task-undo-all').props.disabled,!allowed,status);assert.equal(h.find('agent-task-undo-change').props.disabled,!allowed,status);if(allowed){await h.find('agent-task-undo-all').props.onClick();assert.deepEqual(h.calls.at(-1),['undo_all',{},'run']);}}finally{h.unmount();}
  }
});

const renderedText=value=>Array.isArray(value)?value.map(renderedText).join(' '):typeof value==='string'||typeof value==='number'?String(value):value&&typeof value==='object'?renderedText(value.props?.children):'';
test('Mio renders safe change projections and natural step titles without raw badges or arguments',()=>{
  const change={id:'change',operation:'timeline.clip.update',summary:'DO_NOT_SHOW_MODEL_SUMMARY',targets:[{kind:'timeline_clip',id:stepId}],before:{private:'DO_NOT_SHOW_RAW_SNAPSHOT'},after:null,reversible:true,status:'applied',display:{operation:'timeline.clip.update',targets:[{kind:'timeline_clip',id:stepId,name:'sound-bed.wav'}],targetCount:1,fields:[{targetIndex:0,property:'gainDb',unit:'db',before:0,after:-8}]}};
  for(const locale of ['zh-Hans','zh-Hant','en','ja']){
    const h=harness({status:'completed',changes:[change],locale});try{
      const step=h.state.snapshot.steps[0];step.toolCall.arguments={credential:'DO_NOT_SHOW_ARGUMENTS',targetId:stepId};step.text='Adjust mioon_generation_submit now';step.approvalRequired=false;step.display={operation:'generation.submit',targets:[],targetCount:0,fields:[]};
      const tree=h.render(),text=renderedText(tree[0]);assert.match(text,/-8\.0 dB/u);assert.match(text,/sound-bed\.wav/u);assert.ok(!text.includes('DO_NOT_SHOW'));assert.ok(!text.includes('mioon_generation_submit'));assert.ok(!text.includes(stepId));assert.ok(!tree.some(node=>node.type==='badge'));assert.equal(h.find('agent-task-consent'),undefined);
      const upload=h.find('agent-task-upload');assert.equal(upload.props.className,'sr-only');assert.equal(upload.props['aria-hidden'],'true');assert.ok(h.find('agent-task-attach'));
    }finally{h.unmount();}
  }
});
test('first send opens a reviewed modal, cancel preserves the draft, and confirm uses only its captured review',async()=>{
  const h=harness({status:'completed'});try{
    h.state.project.authorization.scopes=[];h.render();const form=h.find('agent-task-draft');const rootForm=h.render().find(node=>node.type==='form');
    assert.equal(h.find('agent-task-send').props.disabled,false);rootForm.props.onSubmit({preventDefault(){}});h.render();
    assert.ok(h.find('agent-task-authorization-dialog'));assert.equal(h.calls.length,0);assert.equal(h.state.draft,'next task');
    const cancel=nodes(h.find('agent-task-authorization-dialog')).find(node=>node.type==='button'&&node.props.children.includes(translate('zh-Hans','common.cancel')));assert.ok(cancel);cancel.props.onClick();h.render();assert.equal(h.find('agent-task-authorization-dialog'),undefined);assert.equal(h.state.draft,'next task');
    rootForm.props.onSubmit({preventDefault(){}});h.render();h.find('agent-task-authorize').props.onClick();await new Promise(resolve=>setImmediate(resolve));h.render();
    assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'authorizeAndSend');assert.equal(h.calls[0][1].text,'next task');assert.equal(h.calls[0][1].model,'current-model');assert.equal(form.props.value,'next task');
  }finally{h.unmount();}
});
test('Enter sends once, Shift+Enter and IME keep editing, while running has a single stop action',async()=>{
  const h=harness({status:'completed'});try{
    h.render();const field=h.find('agent-task-draft'),prevented=[];
    for(const patch of [{shiftKey:true},{composing:true},{keyCode:229}])field.props.onKeyDown({key:'Enter',shiftKey:false,keyCode:13,nativeEvent:{isComposing:patch.composing??false},preventDefault(){prevented.push(1);},...patch});
    assert.equal(h.calls.length,0);assert.equal(prevented.length,0);
    field.props.onKeyDown({key:'Enter',shiftKey:false,keyCode:13,nativeEvent:{isComposing:false},preventDefault(){prevented.push(1);}});h.render().find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(h.calls,[['send']]);assert.equal(prevented.length,1);
  }finally{h.unmount();}
  const active=harness({status:'running'});try{const tree=active.render();assert.equal(tree.filter(node=>node.props?.['data-testid']==='agent-task-stop').length,1);assert.equal(active.find('agent-task-send'),undefined);active.find('agent-task-stop').props.onClick();assert.deepEqual(active.calls,[['stop',{},'run']]);}finally{active.unmount();}
});
test('the header opens the conversation overlay and selects a conversation through its read-only session route',()=>{
  const h=harness({status:'completed'});try{h.render();h.find('agent-task-history-open').props.onClick();const tree=h.render(),history=tree.find(node=>node.type==='conversation-history');assert.equal(history.props.open,true);assert.deepEqual(history.props.conversations,h.state.history.conversations);history.props.onSelect('run');assert.deepEqual(h.calls,[['history'],['selectConversation','run']]);assert.ok(!h.calls.some(call=>call[0]==='send'));}finally{h.unmount();}
});

 test('the next-send model label uses current settings rather than the selected historical round',()=>{
  const h=harness({status:'completed'});try{const tree=h.render(),menu=tree.find(node=>node.type==='popover-content');assert.match(renderedText(menu),/current-model/u);assert.ok(!renderedText(menu).includes('historical-model'));}finally{h.unmount();}
});
test('only target conflicts show the conflict pause explanation and unknown results use recovery',()=>{
  const h=harness({status:'paused'});try{for(const reason of ['conflict','editing','user','AGENT_TASK_CONSENT_REQUIRED']){h.state.snapshot.run.pauseReason=reason;h.render();const text=renderedText(h.find('agent-task-paused'));assert.equal(text.includes(translate('zh-Hans','agent.panel.conflictBody')),['conflict','editing'].includes(reason));}h.state.snapshot.steps[0].status='unknown';h.render();assert.equal(h.find('agent-task-paused'),undefined);assert.ok(h.find(`agent-task-unknown-${stepId}`));assert.equal(h.find('agent-task-resume').props.disabled,true);}finally{h.unmount();}
});

test('failure settings links route by stable error code and unknown diagnostics add no misleading destination',()=>{
  for(const [code,page]of [['FFMPEG_MISSING','video-tools'],['SUBTITLE_RENDERER_UNAVAILABLE','video-tools'],['EXPORT_CAPABILITY_UNSUPPORTED','video-tools'],['AGENT_CHAT_TIMEOUT','agent'],['PROVIDER_DISABLED','models'],['UNRECOGNIZED',undefined],['AGENT_CHAT_UNRECOGNIZED',undefined],['AGENT_CHAT_STORAGE_UNAVAILABLE',undefined],['AGENT_CHAT_BUSY',undefined],['AGENT_CHAT_ABORTED',undefined],['PROVIDER_UNRECOGNIZED',undefined],['IMAGE_UNRECOGNIZED',undefined]]){
    const h=harness({status:'failed'});try{h.state.snapshot.steps[0].error={code,message:'UNTRUSTED_DIAGNOSTIC'};h.render();const link=h.find(`agent-task-error-settings-${stepId}`);if(page){assert.ok(link);link.props.onClick();assert.deepEqual(h.calls,[['settings',page]]);}else assert.equal(link,undefined);}finally{h.unmount();}
  }
});

test('conflict pause shows only the exact safe planned values and server-projected current values',()=>{
  const h=harness({status:'paused'});try{h.state.snapshot.run.pauseReason='conflict';const step=h.state.snapshot.steps[0];step.status='intent';step.approvalRequired=false;step.display={operation:'timeline.clip.update',targets:[{kind:'timeline_clip',id:stepId,name:'opening.mp4'}],targetCount:1,fields:[{targetIndex:0,property:'durationFrames',unit:'frames',after:60,current:90}]};h.render();const card=renderedText(h.find('agent-task-paused'));assert.ok(card.includes('opening.mp4'));assert.ok(card.includes(translate('zh-Hans','agent.panel.yourChanges')));assert.ok(card.includes('90'));assert.ok(card.includes(translate('zh-Hans','agent.panel.originalPlan')));assert.ok(card.includes('60'));assert.ok(!card.includes(stepId));}finally{h.unmount();}
  const missing=harness({status:'paused'});try{missing.state.snapshot.run.pauseReason='conflict';missing.render();assert.ok(!renderedText(missing.find('agent-task-paused')).includes(translate('zh-Hans','agent.panel.yourChanges')));}finally{missing.unmount();}
});

test('background conflicts use the host-marked completed step rather than guessing from later completed tools',()=>{
 const h=harness({status:'paused'});try{h.state.snapshot.run.pauseReason='conflict';const blocked=h.state.snapshot.steps[0];blocked.approvalRequired=false;blocked.status='completed';blocked.display={operation:'generation.submit',targets:[{kind:'shot',id:stepId,name:'Original blocked scene'}],targetCount:1,fields:[{targetIndex:0,property:'durationSeconds',unit:'seconds',after:4}],conflict:true};h.state.snapshot.steps.push({...blocked,id:'later-step',display:{...blocked.display,conflict:undefined,targets:[{kind:'shot',id:projectId,name:'Unrelated later scene'}]}});h.render();const text=renderedText(h.find('agent-task-paused'));assert.ok(text.includes('Original blocked scene'));assert.ok(!text.includes('Unrelated later scene'));assert.ok(text.includes(translate('zh-Hans','agent.panel.originalPlan')));}finally{h.unmount();}
});

test('the selected legacy conversation is read-only and never exposes proposal JSON or raw status names',()=>{
  const legacySource=readFileSync(new URL('../apps/web/src/AgentLegacyHistory.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(legacySource,/createAgentChatClient|createAgentEditsClient|\.apply\(|\.reject\(|\.start\(|\.stop\(/u);
  for(const locale of ['zh-Hans','zh-Hant','en','ja']){
    const react={createElement:(type,props,...children)=>({type,props:{...props,children}})};react.default=react;const module={exports:{}};
    Function('module','exports','require',transformSync(legacySource,{loader:'tsx',format:'cjs'}).code)(module,module.exports,id=>{
      if(id==='react')return react;if(id.includes('I18nProvider'))return{useI18n:()=>createI18nTestContext(locale)};if(id.includes('workbench-controls'))return{WorkbenchButton:'button'};if(id.includes('contracts/src/agent-tasks-v2'))return{AGENT_TASK_STATUSES};if(id==='./agent-task-presentation.ts')return{taskOperationTitle:presentation.taskOperationTitle};if(id==='./agent-edits.ts')return{agentEditStatusDescriptor:()=>message('agent.proposal.state.applied')};throw Error('Unexpected import '+id);
    });
    const conversation={runs:[{id:'old-run',userText:'Earlier question',assistantText:'Earlier reply',status:'completed'}],proposals:[{id:'old-proposal',operation:'shot.update',status:'applied',diff:{secret:'PRIVATE_DIFF_MUST_STAY_HIDDEN',targetId:'PRIVATE_TARGET'}}],chatCursor:null,editCursor:null};
    const tree=module.exports.default({conversation});const text=renderedText(tree);assert.match(text,/Earlier question.*Earlier reply/u);assert.ok(text.includes(translate(locale,'agent.task.status.completed')));assert.ok(text.includes(presentation.taskOperationTitle('shot.update',locale)));assert.doesNotMatch(text,/PRIVATE_|shot\.update|\bcompleted\b/u);assert.ok(!nodes(tree).some(node=>node.type==='pre'||node.type==='badge'));
  }
});

test('selecting legacy history keeps the project recovery owner mounted without exposing its controls or a restored-workspace label',()=>{
  const h=harness({status:'completed'});try{
    const original=h.render().find(node=>node.type==='retained');assert.ok(original);assert.equal(original.props.visible,true);
    h.state.legacy=true;h.state.conversationId=null;h.state.conversation=null;h.state.rounds=[];h.state.snapshot=null;h.state.selectionKey='legacy:old';
    const tree=h.render(),owner=h.find('agent-task-retained-owner'),retained=tree.filter(node=>node.type==='retained');
    assert.equal(retained.length,1,'The independently pending recovery receipt must keep its native-close registration');
    assert.equal(retained[0].props.projectId,original.props.projectId);assert.equal(retained[0].props.nativeCloseRegistry,original.props.nativeCloseRegistry);
    assert.equal(retained[0].props.visible,false);assert.equal(retained[0].props.readOnly,false);assert.equal(retained[0].props.recovery,null);
    assert.equal(owner.props.hidden,true);assert.equal(owner.props.inert,true);assert.equal(h.find('agent-task-read-only'),undefined);assert.equal(h.find('agent-task-empty'),undefined);
    assert.equal(h.find('agent-task-draft').props.disabled,true);assert.equal(h.find('agent-task-send').props.disabled,true);
  }finally{h.unmount();}
});
