import type {TaskPanelChange,TaskPanelSnapshot,TaskPanelState,TaskPanelOptions,TaskPanelStep,ElementProps} from './helpers/strict-agent-ui-types.ts';
import type {Locale} from '../packages/i18n/src/types.ts';
import type {Tree, Element, Hook, Module} from './helpers/strict-agent-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createI18nTestContext, translate } from './helpers/i18n.ts';
import { agentTaskErrorKey } from '../apps/web/src/agent-task-errors.ts';
import * as presentation from '../apps/web/src/agent-task-presentation.ts';
import * as requirements from '../apps/web/src/agent-task-requirements.ts';
import { message } from '../packages/i18n/src/index.ts';
import {agentTaskNewConversationBlock,agentTaskSessionBusy,agentTaskWaitingQuestion} from '../apps/web/src/agent-tasks-v2.ts';
import * as questions from '../apps/web/src/agent-task-questions.ts';
import * as reviews from '../apps/web/src/agent-task-reviews.ts';
const nodes=(value: Tree): Element[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const source=readFileSync(new URL('../apps/web/src/AgentTaskPanel.tsx',import.meta.url),'utf8');
const projectId='11111111-1111-4111-8111-111111111111',stepId='22222222-2222-4222-8222-222222222222';
function harness({backgroundPending=false,readOnly=false,status,changes=[],locale='zh-Hans'}: {backgroundPending?: boolean;readOnly?: boolean;status?: string;changes?: TaskPanelChange[];locale?: Locale}={}){
  let currentLocale=locale,currentProjectId=projectId,refreshResult: Promise<unknown>|null=null,currentVisible=true;
  const hooks: Hook[]=[];let cursor=0,pending: number[]=[],tree: Tree,loads=0;const calls: unknown[][]=[];
  const react={createElement:(type: string,props: Partial<ElementProps>|null,...children: Tree[])=>({type,props:{...props,children:type==='dialog'&&!props!.open?[]:type==='dialog-content'?[...children,props!.footer]:type==='retained'?[...children,props!.recovery]:children}}),Fragment:'fragment',useRef:(value: unknown)=>hooks[cursor++]??={current:value},useState:(value: unknown)=>{const index=cursor++;hooks[index]??={value};return[hooks[index].value,(next: (arg0: unknown) => unknown)=>{hooks[index].value=typeof next==='function'?next(hooks[index].value):next;}];},useLayoutEffect:(fn: ()=>void|(()=>void),deps: readonly unknown[])=>{const index=cursor++,old=hooks[index];if(!old||deps.some((value: unknown,at)=>value!==old.deps![at])){hooks[index]={...old,fn,deps};pending.push(index);}}};(react as typeof react & {default?: unknown}).default=react;
  const snapshot: TaskPanelSnapshot={run:{id:'run',projectId,text:'synthetic task',status:status??(backgroundPending?'completed':'awaiting_approval'),stepsUsed:2,budget:30,configuration:{model:'historical-model'}},steps:[{id:stepId,kind:'tool',status:'completed',approvalRequired:true,tier:'paid',toolCall:{name:'mioon_generation_submit',arguments:{}}}],changes,backgroundPending};
  const state: TaskPanelState={phase:'ready',project:{readOnly,runs:[snapshot.run],authorization:{scopes:['project_agent']},settings:{configuration:{model:'current-model'}}},snapshot,draft:'next task',uploads:[],pending:null,error:'',conversationId:'run',conversation:{id:'run',title:'synthetic task'},rounds:[snapshot],selectionKey:'run',draftDirty:true,draftVersion:0,unknownOutcome:false,history:{conversations:[{id:'run',title:'synthetic task'}],nextCursor:null,phase:'ready'}};
  const module: Module={exports:{}};let options: TaskPanelOptions;
  const previous=globalThis.document;globalThis.document={visibilityState:'visible',addEventListener(){},removeEventListener(){}} as unknown as Document;
  Function('module','exports','require',transformSync(source,{loader:'tsx',format:'cjs'}).code)(module,module.exports,(id: string|string[])=>{
    if(id==='react')return react;if(id==='./agent-task-presentation.ts')return presentation;if(id==='./agent-task-requirements.ts')return requirements;if(id.includes('packages/i18n/src/index.ts'))return{message};if(id.includes('workbench-confirm'))return{useConfirmation:()=>async()=>true};if(id.includes('workbench-controls'))return{WorkbenchButton:'button',WorkbenchDialogContent:'dialog-content'};if(id.includes('/dialog'))return{Dialog:'dialog'};if(id.includes('workbench-tooltip'))return{WorkbenchTooltip:'tooltip'};if(id.includes('workbench-popover'))return{WorkbenchPopover:'popover',WorkbenchPopoverContent:'popover-content',WorkbenchPopoverTrigger:'popover-trigger'};if(id==='./AgentRetainedEditing.tsx')return{__esModule:true,default:'retained'};if(id.includes('I18nProvider'))return{useI18n:()=>createI18nTestContext(currentLocale)};if(id==='./agent-task-errors.ts')return{agentTaskErrorKey};if(id.includes('workspace-visibility'))return{useWorkspaceVisibility:()=>currentVisible};if(id==='./AgentConversationHistory.tsx')return{__esModule:true,default:'conversation-history'};if(id==='./agent-task-questions.ts')return questions;if(id==='./agent-task-reviews.ts')return reviews;if(id==='./AgentTaskContinuityReport.tsx')return{__esModule:true,default:'continuity-report'};if(id==='./AgentTaskQuestion.tsx')return{AgentTaskQuestionCard:'question-card',AgentTaskAnswerRow:'answer-row'};if(id==='./agent-tasks-v2.ts')return{agentTaskNewConversationBlock,agentTaskSessionBusy,agentTaskWaitingQuestion,createAgentTaskReceiptStore:()=>({}),agentTaskPromptValid:()=>true,createAgentTaskSession:(value: TaskPanelOptions)=>{options=value;return{getState:()=>state,load(){loads++;value.onChange(state);},setVisible(){},dispose(){},cancelSelection(){},refreshRound:async (id: string)=>{calls.push(['refreshRound',id]);if(refreshResult)return await refreshResult;return state.rounds.find(item=>item.run.id===id)??null;},action:(...args: unknown[])=>calls.push(args),send:async()=>{calls.push(['send']);return true;},note:async()=>{calls.push(['note']);return true;},answer:async(...args: unknown[])=>{calls.push(['answer',...args]);return true;},authorizationReview:()=>({projectId,settingsRevision:1,authorizationRevision:1,destination:'https://example.invalid/v1/responses',model:'current-model',text:state.draft,uploads:state.uploads.map(item=>item.id),locale:currentLocale}),authorizeAndSend:async (value: unknown)=>{calls.push(['authorizeAndSend',value]);return true;},edit:(value: string)=>{state.draft=value;calls.push(['edit',value]);},removeUpload:(id: unknown)=>{state.uploads=state.uploads.filter(item=>item.id!==id);},history(){calls.push(['history']);},selectConversation:async(...args: unknown[])=>{calls.push(['selectConversation',...args]);return true;},newConversation:()=>{calls.push(['newConversation']);return true;}};}};
    if(id.includes('native-close-sources'))return{createAgentTaskCloseReporter:()=>({publish(){},release(){}})};if(id.includes('agent-settings.ts'))return{deriveAgentEndpoint:()=>'/synthetic'};if(id.includes('/button'))return{Button:'button'};if(id.includes('/textarea'))return{Textarea:'textarea'};if(id.includes('/input'))return{Input:'input'};if(id.includes('/badge'))return{Badge:'badge'};return{__esModule:true,default:'placeholder'};
  });
  const render=()=>{cursor=0;pending=[];tree=module.exports.default!({projectId:currentProjectId,onSettings(page: unknown){calls.push(page ? ['settings',page] : ['settings']);},onClose(){}});for(const index of pending){hooks[index].cleanup?.();hooks[index].cleanup=hooks[index].fn!();}return nodes(tree);};render();
  return{render,calls,state,setLocale(value: Locale){currentLocale=value;},setProject(value: string){currentProjectId=value;},setVisible(value: boolean){currentVisible=value;},setRefresh(value: Promise<unknown>|null){refreshResult=value;},get options(){return options;},get loads(){return loads;},find:(id: unknown)=>nodes(tree).find((node)=>node.props?.['data-testid']===id),unmount(){for(const hook of hooks)hook.cleanup?.();globalThis.document=previous;}};
}
test('a completed-conversation refresh keeps real panel inputs and write controls disabled until it settles',async()=>{
  const h=harness({status:'completed'});try{
    h.state.phase='refreshing';const tree=h.render();
    for(const id of ['agent-task-draft','agent-task-send','agent-task-upload',`agent-task-approve-${stepId}`])assert.equal(h.find(id)!.props.disabled,true,id);
    tree.find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(h.calls,[]);assert.equal(h.state.draft,'next task');
    h.state.phase='ready';h.render();for(const id of ['agent-task-draft','agent-task-send','agent-task-upload'])assert.equal(h.find(id)!.props.disabled,false,id);
  }finally{h.unmount();}
});

test('a following log opens on the latest content when its dock tab or the history overlay shows it again',()=>{
  const h=harness({status:'failed'});
  try{
    // Loaded behind another dock tab: the hidden log has no height to scroll to yet.
    h.setVisible(false);h.render();
    const log=h.find('agent-task-activity')!.props.ref as unknown as {current: {scrollTop: number;scrollHeight: number;clientHeight: number;querySelector: ()=>null}|null};
    log.current={scrollTop:0,scrollHeight:0,clientHeight:0,querySelector:()=>null};h.render();
    Object.assign(log.current,{scrollHeight:900,clientHeight:300});
    h.setVisible(true);h.render();
    assert.equal(log.current.scrollTop,900,'showing the Mio tab measures the log again');
    h.find('agent-task-history-open')!.props.onClick();h.render();log.current.scrollTop=0;
    (h.render().find(node=>node.type==='conversation-history')!.props.onClose as ()=>void)();h.render();
    assert.equal(log.current.scrollTop,900,'closing the history overlay returns to the latest content');
    // A reader who scrolled up keeps their place.
    (h.find('agent-task-activity')!.props.onScroll as (event: {currentTarget: {scrollHeight: number;clientHeight: number;scrollTop: number}})=>void)({currentTarget:{scrollHeight:900,clientHeight:300,scrollTop:120}});log.current.scrollTop=120;
    h.setVisible(false);h.render();h.setVisible(true);h.render();
    assert.equal(log.current.scrollTop,120);assert.ok(h.find('agent-task-latest'),'the latest button stays offered');
  }finally{h.unmount();}
});
test('a read-only load error keeps its reload action visible and cannot send without a verified project',()=>{
  const h=harness();try{h.state.phase='read_error';h.state.error='NETWORK';h.state.project=null;h.state.snapshot=null;h.state.draft='';h.render();assert.ok(h.find('agent-task-error'));const reload=h.find('agent-task-reload');assert.ok(reload);assert.equal(reload.props.disabled,false);assert.equal(h.find('agent-task-send')!.props.disabled,true);const loads=h.loads;reload.props.onClick();assert.equal(h.loads,loads+1);assert.deepEqual(h.calls,[]);}finally{h.unmount();}
});
test('a saved step failure is localized by code beside its unknown-result controls',()=>{
  const h=harness();try{const step=h.state.snapshot!.steps[0];step.kind='model';step.status='unknown';step.error={code:'AGENT_CHAT_HTTP_ERROR',message:'模型服务拒绝了请求（HTTP 401）。'};h.render();const error=h.find(`agent-task-step-error-${stepId}`);assert.ok(error);assert.equal(error.props.role,'alert');assert.deepEqual(error.props.children,[translate('zh-Hans','agent.panel.failureReason',{reason:translate('zh-Hans',agentTaskErrorKey(step.error.code))})]);assert.notEqual(error.props.children[0],step.error.message);assert.equal(error.props.dangerouslySetInnerHTML,undefined);}finally{h.unmount();}
});

test('an unknown paid step can be marked failed after checking the task center; other irreversible steps only check',()=>{
  const h=harness({status:'interrupted'});try{
    const step=h.state.snapshot!.steps[0];step.status='unknown';h.render();
    const card=renderedText(h.find(`agent-task-unknown-${stepId}`)!),mark=h.find(`agent-task-mark-failed-${stepId}`);
    assert.ok(card.includes(translate('zh-Hans','agent.task.paidReconcile')));assert.ok(mark);assert.equal(mark.props.disabled,false);
    assert.equal(renderedText(mark),translate('zh-Hans','agent.panel.markFailed'));
    (mark.props.onClick as ()=>void)();assert.deepEqual(h.calls.at(-1),['resolve_unknown',{stepId,resolution:'discard'},'run']);
    step.tier='local_irreversible';h.render();
    assert.equal(h.find(`agent-task-mark-failed-${stepId}`),undefined);assert.ok(renderedText(h.find(`agent-task-unknown-${stepId}`)!).includes(translate('zh-Hans','agent.task.waitReconcile')));
  }finally{h.unmount();}
});

test('Mio localizes step, run and transport errors without rendering diagnostic messages',()=>{
  for(const locale of ['zh-Hans','zh-Hant','en','ja'] as const){
    const h=harness({locale,status:'failed'});
    try{
      h.state.snapshot!.run.pauseReason='AGENT_CHAT_TIMEOUT';
      h.state.snapshot!.steps[0].error={code:'AGENT_CHAT_HTTP_ERROR',message:'diagnostic <b>untrusted text</b>'};
      h.state.error='AGENT_TASK_CONSENT_REQUIRED';h.render();
      assert.deepEqual(h.find(`agent-task-step-error-${stepId}`)!.props.children,[translate(locale,'agent.panel.failureReason',{reason:translate(locale,agentTaskErrorKey('AGENT_CHAT_HTTP_ERROR'))})]);
      assert.ok(h.find('agent-task-run-error')!.props.children.includes(translate(locale,'agent.panel.failedTail')));
      assert.deepEqual(h.find('agent-task-error')!.props.children,[translate(locale,agentTaskErrorKey('AGENT_TASK_CONSENT_REQUIRED'))]);
      h.state.snapshot!.steps[0].error.code='UNRECOGNIZED';h.render();
      assert.deepEqual(h.find(`agent-task-step-error-${stepId}`)!.props.children,[translate(locale,'agent.panel.failureReason',{reason:translate(locale,agentTaskErrorKey(undefined))})]);
    }finally{h.unmount();}
  }
});

test('preparing has no step budget and a locale change retains the panel session and draft',()=>{
  const h=harness({status:'accepted',locale:'zh-Hans'});
  try{
    h.render();const options: TaskPanelOptions=h.options;const loads=h.loads;
    assert.equal(options.getLocale(),'zh-Hans');
    assert.equal(JSON.stringify(h.find('agent-task-status')).includes(translate('zh-Hans','agent.task.budget',{used:2,limit:30})),false);
    h.setLocale('ja');h.render();
    assert.equal(h.options,options);assert.equal(h.loads,loads);
    assert.equal(options.getLocale(),'ja');assert.equal(h.state.draft,'next task');
    assert.deepEqual(nodes(h.find('agent-task-status')).find((node)=>node.type==='strong')!.props.children,[translate('ja','agent.task.status.accepted')]);
  }finally{h.unmount();}
});
test('an already accepted generation with renewed approval requirement renders the same exact-step approval card',()=>{
  const h=harness();try{h.render();assert.ok(h.find(`agent-task-approval-${stepId}`));h.find(`agent-task-approve-${stepId}`)!.props.onClick();assert.deepEqual(h.calls[0],['approve',{stepId},'run']);const card=h.find(`agent-task-approval-${stepId}`),buttons=nodes(card).filter((node)=>node.type==='button');assert.equal(buttons.length,3);h.find(`agent-task-deny-${stepId}`)!.props.onClick();assert.deepEqual(h.calls[1],['deny',{stepId},'run']);buttons.at(-1)!.props.onClick();assert.deepEqual(h.calls[2],['settings']);}finally{h.unmount();}
});
test('unfinished background work blocks another send while retaining pause/stop controls and read-only history selection',()=>{
  const h=harness({backgroundPending:true});try{h.render();assert.ok(h.find('agent-task-background-pending'));assert.ok(h.find('agent-task-pause'));assert.ok(h.find('agent-task-stop'));assert.equal(h.find('agent-task-send')!.props.disabled,true);assert.equal(h.find('agent-task-new-conversation')!.props.disabled,true);const upload=h.find('agent-task-upload');assert.equal(upload!.type,'input');assert.equal(upload!.props.type,'file');assert.equal(upload!.props.disabled,false);}finally{h.unmount();}
  const restored=harness({readOnly:true});try{restored.state.draft='';const tree=restored.render();assert.ok(restored.find('agent-task-read-only'));const history=tree.find((node)=>node!.type==='conversation-history');assert.equal(history!.props.disabled,false);assert.equal(restored.find('agent-task-send'),undefined);assert.equal(restored.find('agent-task-stop')!.props.disabled,true);assert.equal(restored.find('agent-task-upload'),undefined);}finally{restored.unmount();}
});

test('undo controls allow only safely finished runs and remain disabled through pause, approval and interruption',async()=>{
  const changes=[{id:'change',summary:'local edit',operation:'shot.update',targets:[],reversible:true,status:'applied',undoDisposition:'undo'}];
  for(const status of ['running','paused','awaiting_approval','interrupted','completed','failed','stopped'] as const){
    const h=harness({status,changes});try{h.render();const allowed=['completed','failed','stopped'].includes(status);assert.equal(h.find('agent-task-undo-all')!.props.disabled,!allowed,status);assert.equal(h.find('agent-task-undo-change')!.props.disabled,!allowed,status);if(allowed){await h.find('agent-task-undo-all')!.props.onClick({currentTarget:{focus(){}}});await new Promise(resolve=>setImmediate(resolve));h.render();assert.deepEqual(h.calls,[['refreshRound','run']]);assert.equal(h.find('agent-task-undo-confirm')!.props.disabled,false);h.find('agent-task-undo-confirm')!.props.onClick();assert.deepEqual(h.calls.at(-1),['undo_all',{undoChangeIds:['change']},'run']);}}finally{h.unmount();}
  }
});

const renderedText=(value: Tree): string=>Array.isArray(value)?value.map(renderedText).join(' '):typeof value==='string'||typeof value==='number'?String(value):value&&typeof value==='object'?renderedText(value.props?.children):'';
test('finished rounds show the saved execution duration rather than a later undo timestamp, and hide legacy unknown durations',()=>{
  for(const status of ['completed','failed','stopped','reverted'] as const){
    const h=harness({status});try{
      Object.assign(h.state.snapshot!.run,{createdAt:'2026-10-23T00:00:00.000Z',updatedAt:'2026-10-23T01:00:00.000Z'});
      h.state.snapshot!.executionEndedAt='2026-10-23T00:00:02.000Z';
      let text=renderedText(h.render()[0]);assert.ok(text.includes(translate('zh-Hans','agent.panel.elapsed',{seconds:2})),status);assert.ok(!text.includes(translate('zh-Hans','agent.panel.elapsed',{seconds:3600})),status);
      delete h.state.snapshot!.executionEndedAt;text=renderedText(h.render()[0]);assert.ok(!text.includes(translate('zh-Hans','agent.panel.elapsed',{seconds:3600})),`${status}: missing execution evidence must not use updatedAt`);
    }finally{h.unmount();}
  }
});
test('Mio renders safe change projections and natural step titles without raw badges or arguments',()=>{
  const change={id:'change',operation:'timeline.clip.update',summary:'DO_NOT_SHOW_MODEL_SUMMARY',targets:[{kind:'timeline_clip',id:stepId}],before:{private:'DO_NOT_SHOW_RAW_SNAPSHOT'},after:null,reversible:true,status:'applied',display:{operation:'timeline.clip.update',targets:[{kind:'timeline_clip',id:stepId,name:'sound-bed.wav'}],targetCount:1,fields:[{targetIndex:0,property:'gainDb',unit:'db',before:0,after:-8}]}};
  for(const locale of ['zh-Hans','zh-Hant','en','ja'] as const){
    const h=harness({status:'completed',changes:[change],locale});try{
      const step=h.state.snapshot!.steps[0];step.toolCall!.arguments={credential:'DO_NOT_SHOW_ARGUMENTS',targetId:stepId};step.text='Adjust mioon_generation_submit now';step.approvalRequired=false;step.display={operation:'generation.submit',targets:[],targetCount:0,fields:[]};
      const tree=h.render(),text=renderedText(tree[0]);assert.match(text,/-8\.0 dB/u);assert.match(text,/sound-bed\.wav/u);assert.ok(!text.includes('DO_NOT_SHOW'));assert.ok(!text.includes('mioon_generation_submit'));assert.ok(!text.includes(stepId));assert.ok(!tree.some((node)=>node!.type==='badge'));assert.equal(h.find('agent-task-consent'),undefined);
      const upload=h.find('agent-task-upload');assert.equal(upload!.props.className,'sr-only');assert.equal(upload!.props['aria-hidden'],'true');assert.ok(h.find('agent-task-attach'));
    }finally{h.unmount();}
  }
});
test('first send opens a reviewed modal, cancel preserves the draft, and confirm uses only its captured review',async()=>{
  const h=harness({status:'completed'});try{
    h.state.project!.authorization.scopes=[];h.render();const form=h.find('agent-task-draft');const rootForm=h.render().find((node)=>node.type==='form');
    assert.equal(h.find('agent-task-send')!.props.disabled,false);rootForm!.props.onSubmit({preventDefault(){}});h.render();
    assert.ok(h.find('agent-task-authorization-dialog'));assert.equal(h.calls.length,0);assert.equal(h.state.draft,'next task');
    const cancel=nodes(h.find('agent-task-authorization-dialog')).find((node)=>node.type==='button'&&node.props.children.includes(translate('zh-Hans','common.cancel')));assert.ok(cancel);cancel.props.onClick();h.render();assert.equal(h.find('agent-task-authorization-dialog'),undefined);assert.equal(h.state.draft,'next task');
    rootForm!.props.onSubmit({preventDefault(){}});h.render();h.find('agent-task-authorize')!.props.onClick();await new Promise(resolve=>setImmediate(resolve));h.render();
    assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'authorizeAndSend');assert.equal((h.calls[0][1] as {text:string;model:string}).text,'next task');assert.equal((h.calls[0][1] as {text:string;model:string}).model,'current-model');assert.equal(form!.props.value,'next task');
  }finally{h.unmount();}
});
test('Enter sends once and Shift+Enter and IME keep editing while running has one composer action',async()=>{
  const h=harness({status:'completed'});try{
    h.render();const field=h.find('agent-task-draft'),prevented=[];
    for(const patch of [{shiftKey:true},{composing:true},{keyCode:229}] as const)field!.props.onKeyDown({key:'Enter',shiftKey:false,keyCode:13,nativeEvent:{isComposing:patch.composing??false},preventDefault(){prevented.push(1);},...patch});
    assert.equal(h.calls.length,0);assert.equal(prevented.length,0);
    field!.props.onKeyDown({key:'Enter',shiftKey:false,keyCode:13,nativeEvent:{isComposing:false},preventDefault(){prevented.push(1);}});h.render().find((node)=>node.type==='form')!.props.onSubmit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(h.calls,[['send']]);assert.equal(prevented.length,1);
  }finally{h.unmount();}
  const active=harness({status:'running'});try{let tree=active.render();assert.equal(active.find('agent-task-stop'),undefined);assert.equal(active.find('agent-task-send')!.props['aria-label'],translate('zh-Hans','agent.panel.sendNote'));active.state.draft='';tree=active.render();assert.equal(tree.filter((node)=>node!.props?.['data-testid']==='agent-task-stop').length,1);assert.equal(active.find('agent-task-send'),undefined);active.find('agent-task-stop')!.props.onClick();assert.deepEqual(active.calls,[['stop',{},'run']]);}finally{active.unmount();}
});
test('the header opens the conversation overlay and selects a conversation through its read-only session route',()=>{
  const h=harness({status:'completed'});try{h.render();h.find('agent-task-history-open')!.props.onClick();const tree=h.render(),history=tree.find((node)=>node!.type==='conversation-history');assert.equal(history!.props.open,true);assert.deepEqual(history!.props.conversations,h.state.history.conversations);history!.props.onSelect('run');assert.deepEqual(h.calls,[['history'],['selectConversation','run']]);assert.ok(!h.calls.some(call=>call[0]==='send'));}finally{h.unmount();}
});

 test('the next-send model label uses current settings rather than the selected historical round',()=>{
  const h=harness({status:'completed'});try{const tree=h.render(),menu=tree.find((node)=>node!.type==='popover-content');assert.match(renderedText(menu),/current-model/u);assert.ok(!renderedText(menu).includes('historical-model'));}finally{h.unmount();}
});
test('only target conflicts show the conflict pause explanation and unknown results use recovery',()=>{
  const h=harness({status:'paused'});try{for(const reason of ['conflict','editing','user','AGENT_TASK_CONSENT_REQUIRED'] as const){h.state.snapshot!.run.pauseReason=reason;h.render();const text=renderedText(h.find('agent-task-paused'));assert.equal(text.includes(translate('zh-Hans','agent.panel.conflictBody')),['conflict','editing'].includes(reason));}h.state.snapshot!.steps[0].status='unknown';h.render();assert.equal(h.find('agent-task-paused'),undefined);assert.ok(h.find(`agent-task-unknown-${stepId}`));assert.equal(h.find('agent-task-resume')!.props.disabled,true);}finally{h.unmount();}
});

test('failure settings links route by stable error code and unknown diagnostics add no misleading destination',()=>{
  for(const [code,page]of [['FFMPEG_MISSING','video-tools'],['SUBTITLE_RENDERER_UNAVAILABLE','video-tools'],['EXPORT_CAPABILITY_UNSUPPORTED','video-tools'],['AGENT_CHAT_TIMEOUT','agent'],['AGENT_SETTINGS_CONFLICT','agent'],['PROVIDER_DISABLED','models'],['PREFLIGHT_STALE',undefined],['UNRECOGNIZED',undefined],['AGENT_CHAT_UNRECOGNIZED',undefined],['AGENT_CHAT_STORAGE_UNAVAILABLE',undefined],['AGENT_CHAT_BUSY',undefined],['AGENT_CHAT_ABORTED',undefined],['PROVIDER_UNRECOGNIZED',undefined],['IMAGE_UNRECOGNIZED',undefined]] as const){
    const h=harness({status:'failed'});try{h.state.snapshot!.steps[0].error={code,message:'UNTRUSTED_DIAGNOSTIC'};h.render();const link=h.find(`agent-task-error-settings-${stepId}`);if(page){assert.ok(link);link.props.onClick();assert.deepEqual(h.calls,[['settings',page]]);}else assert.equal(link,undefined);}finally{h.unmount();}
  }
});

test('conflict pause shows only the exact safe planned values and server-projected current values',()=>{
  const h=harness({status:'paused'});try{h.state.snapshot!.run.pauseReason='conflict';const step=h.state.snapshot!.steps[0];step.status='intent';step.approvalRequired=false;step.display={operation:'timeline.clip.update',targets:[{kind:'timeline_clip',id:stepId,name:'opening.mp4'}],targetCount:1,fields:[{targetIndex:0,property:'durationFrames',unit:'frames',after:60,current:90}]};h.render();const card=renderedText(h.find('agent-task-paused'));assert.ok(card.includes('opening.mp4'));assert.ok(card.includes(translate('zh-Hans','agent.panel.yourChanges')));assert.ok(card.includes('90'));assert.ok(card.includes(translate('zh-Hans','agent.panel.originalPlan')));assert.ok(card.includes('60'));assert.ok(!card.includes(stepId));}finally{h.unmount();}
  const missing=harness({status:'paused'});try{missing.state.snapshot!.run.pauseReason='conflict';missing.render();assert.ok(!renderedText(missing.find('agent-task-paused')).includes(translate('zh-Hans','agent.panel.yourChanges')));}finally{missing.unmount();}
});

test('conflict comparison shares target, current and planned rows before its explanation in all four languages',()=>{
  const content={
    'zh-Hans':['A/B 对比：雨后的城市，保留左/右机位的长镜头','慢慢推进，让街道的反光进入画面'],
    'zh-Hant':['A/B 對比：雨後的城市，保留左/右機位的長鏡頭','慢慢推進，讓街道的反光進入畫面'],
    en:['A/B comparison: a long uninterrupted left/right view of the city after rain','Move slowly closer so that the reflections on the street enter the frame'],
    ja:['A/B 比較：雨上がりの街を左/右から捉えた長いカットを保つ','ゆっくり近づいて道路に映る光が画面に入るようにする'],
  };
  for(const locale of Object.keys(content) as (keyof typeof content)[]){
    const h=harness({status:'paused',locale});try{
      h.state.snapshot!.run.pauseReason='conflict';const step=h.state.snapshot!.steps[0];step.status='intent';step.approvalRequired=false;
      step.display={operation:'shot.update',targets:[{kind:'shot',id:stepId,name:'左/右机位'}],targetCount:1,fields:[{targetIndex:0,property:'description',unit:'text',current:content[locale][0],after:content[locale][1]}]};
      h.render();const card=h.find('agent-task-paused'),comparison=h.find('agent-task-conflict-values');
      assert.equal(comparison!.type,'dl');assert.equal(nodes(comparison).filter((node)=>node.type==='dl').length,1);
      assert.deepEqual(nodes(comparison).filter((node)=>node.type==='dt').map(renderedText),['agent.panel.conflictTarget','agent.panel.yourChanges','agent.panel.originalPlan'].map(key=>translate(locale,key as Parameters<typeof translate>[1])));
      assert.ok(renderedText(comparison).includes('左/右机位'));for(const value of content[locale])assert.ok(renderedText(comparison).includes(value));
      assert.ok(!renderedText(comparison).includes(stepId));
      const children=(card!.props.children as unknown[]).flat(Infinity).filter(Boolean) as Element[],index=children.indexOf(comparison!);
      assert.ok(index>0);assert.equal(children[index+1].type,'p');assert.equal(renderedText(children[index+1]),translate(locale,'agent.panel.conflictBody'));assert.equal(children[index+2].props.className,'mio-card-actions');
      step.display.fields=[];h.render();assert.equal(nodes(h.find('agent-task-conflict-values')).filter((node)=>node.type==='dt').length,1,'Missing current and planned evidence must not create guessed values');
    }finally{h.unmount();}
  }
});

test('background conflicts use the host-marked completed step rather than guessing from later completed tools',()=>{
 const h=harness({status:'paused'});try{h.state.snapshot!.run.pauseReason='conflict';const blocked=h.state.snapshot!.steps[0];blocked.approvalRequired=false;blocked.status='completed';blocked.display={operation:'generation.submit',targets:[{kind:'shot',id:stepId,name:'Original blocked scene'}],targetCount:1,fields:[{targetIndex:0,property:'durationSeconds',unit:'seconds',after:4}],conflict:true};h.state.snapshot!.steps.push({...blocked,id:'later-step',display:{...blocked.display,conflict:undefined,targets:[{kind:'shot',id:projectId,name:'Unrelated later scene'}]}});h.render();const text=renderedText(h.find('agent-task-paused'));assert.ok(text.includes('Original blocked scene'));assert.ok(!text.includes('Unrelated later scene'));assert.ok(text.includes(translate('zh-Hans','agent.panel.originalPlan')));}finally{h.unmount();}
});

test('a completed conversation keeps the project recovery owner mounted and visible',()=>{
  const h=harness({status:'completed'});try{
    const retained=h.render().find((node)=>node.type==='retained');assert.ok(retained);assert.equal(retained.props.visible,true);
  }finally{h.unmount();}
});

test('active round text sends only a note in all three allowed states, and only the running tag offers pause',async()=>{
  for(const locale of ['zh-Hans','zh-Hant','en','ja'] as const)for(const status of ['running','awaiting_approval','paused'] as const){
    const h=harness({locale,status});try{
      h.render();const field=h.find('agent-task-draft'),button=h.find('agent-task-send');assert.equal(field!.props.placeholder,translate(locale,status==='paused'?'agent.panel.pausedNoteDraft':'agent.panel.noteDraft'));assert.equal(button!.props['aria-label'],translate(locale,'agent.panel.sendNote'));assert.equal(button!.props.disabled,false);
      assert.equal(Boolean(h.find('agent-task-pause')),status==='running');assert.equal(h.find('agent-task-attach')!.props.disabled,true);assert.equal(h.find('agent-task-upload')!.props.disabled,true);
      field!.props.onKeyDown({key:'Enter',shiftKey:false,keyCode:13,nativeEvent:{isComposing:false},preventDefault(){}});h.render().find((node)=>node.type==='form')!.props.onSubmit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(h.calls,[['note']]);
      h.state.draft='';h.render();assert.equal(h.find('agent-task-send'),undefined);assert.ok(h.find('agent-task-stop'));
    }finally{h.unmount();}
  }
});

test('the note composer updates after status changes without consuming the draft or its attachments',async()=>{
  const h=harness({status:'running'});try{
    const upload={id:'saved-file',name:'next.mp4',status:'staged',mimeType:'video/mp4'};h.state.uploads=[upload];h.render();assert.equal(h.find('agent-task-draft')!.props.placeholder,translate('zh-Hans','agent.panel.noteDraft'));assert.ok(renderedText(h.render()[0]).includes(translate('zh-Hans','agent.panel.attachNextRound')));
    h.state.snapshot!.run.status='paused';h.render();assert.equal(h.find('agent-task-draft')!.props.placeholder,translate('zh-Hans','agent.panel.pausedNoteDraft'));
    h.state.snapshot!.run.status='completed';h.render();assert.equal(h.find('agent-task-draft')!.props.placeholder,translate('zh-Hans','agent.panel.continuedraft'));assert.equal(h.find('agent-task-send')!.props['aria-label'],translate('zh-Hans','agent.task.send'));assert.equal(h.find('agent-task-upload')!.props.disabled,false);
    assert.equal(h.state.draft,'next task');assert.deepEqual(h.state.uploads,[upload]);h.state.unknownOutcome=true;h.render();assert.equal(h.find('agent-task-draft')!.props.disabled,true);assert.equal(h.find('agent-task-send')!.props.disabled,true);assert.equal(h.find('agent-task-draft')!.props.placeholder,translate('zh-Hans','agent.panel.blockedDraft'));
  }finally{h.unmount();}
});

test('five pending notes show a translated queue notice and block another submit without clearing the draft',async()=>{
  for(const locale of ['zh-Hans','zh-Hant','en','ja'] as const){
    const h=harness({status:'running',locale});try{
      h.state.snapshot!.run.notes=Array.from({length:5},(_,index)=>({requestId:`note-${index}`,text:`An instruction ${index}`,createdAt:'2026-10-22T00:00:00.000Z'}));h.render();assert.equal(h.find('agent-task-send')!.props.disabled,true);assert.equal(renderedText(h.find('agent-task-note-limit')),translate(locale,'agent.task.error.noteLimit'));
      h.render().find((node)=>node.type==='form')!.props.onSubmit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls.length,0);assert.equal(h.state.draft,'next task');
      h.state.snapshot!.run.notes[0].modelStepId='next-model';h.render();assert.equal(h.find('agent-task-note-limit'),undefined);assert.equal(h.find('agent-task-send')!.props.disabled,false);
    }finally{h.unmount();}
  }
});

test('round notes appear as labelled user messages on their model boundary rather than leaking into another round',()=>{
  for(const locale of ['zh-Hans','zh-Hant','en','ja'] as const){
    const h=harness({status:'running',locale});try{
      const snapshot: TaskPanelSnapshot=h.state.snapshot!;snapshot.steps=[{id:'model-one',kind:'model',position:1,status:'completed',text:'The first response'},{id:'model-two',kind:'model',position:3,status:'completed',text:'The response after the saved instruction'}];snapshot.run.notes=[{requestId:'bound-note',text:'Keep the A/B subtitle',modelStepId:'model-two',createdAt:'2026-10-22T00:00:00.000Z'},{requestId:'pending-note',text:'Use the left/right angle next',createdAt:'2026-10-22T00:00:01.000Z'}];
      const old={run:{...snapshot.run,id:'previous-round',status:'completed',notes:undefined},steps:[],changes:[]};h.state.rounds=[old,snapshot];h.render();const rounds=h.render().filter((node)=>node.props?.['data-testid']==='agent-task-round');assert.equal(nodes(rounds[0]).filter((node)=>node.props?.['data-testid']==='agent-task-note').length,0);
      const entries=nodes(rounds[1]),messages=entries.filter((node)=>node.props?.['data-testid']==='agent-task-note');assert.equal(messages.length,2);for(const entry of messages){assert.match(entry.props.className,/is-user/u);assert.ok(renderedText(entry).includes(translate(locale,'agent.panel.note')));}
      const reply=entries.findIndex((node)=>node.props?.['data-testid']==='agent-task-reply');assert.ok(entries.indexOf(messages[0])<reply);assert.ok(entries.indexOf(messages[1])>reply);assert.ok(!renderedText(rounds[1]).includes('pending-note'));assert.ok(!renderedText(rounds[1]).includes('model-two'));
    }finally{h.unmount();}
  }
});

test('target conflict offers exact-run skip and stop while an ordinary pause still resumes',()=>{
  for(const reason of ['conflict','editing','user'] as const){
    const h=harness({status:'paused'});try{
      h.state.snapshot!.run.pauseReason=reason;h.render();const skip=['conflict','editing'].includes(reason);assert.equal(renderedText(h.find('agent-task-resume')),translate('zh-Hans',skip?'agent.panel.skipContinue':'agent.task.resume'));h.find('agent-task-resume')!.props.onClick();assert.deepEqual(h.calls[0],[skip?'skip':'resume',undefined,'run']);h.find('agent-task-stop')!.props.onClick();assert.deepEqual(h.calls[1],['stop',undefined,'run']);
    }finally{h.unmount();}
  }
});

test('skipped rows come only from the skip list, expose actual current values and do not become undoable changes',()=>{
  for(const locale of ['zh-Hans','zh-Hant','en','ja'] as const){
    const h=harness({status:'completed',locale});try{
      const step=h.state.snapshot!.steps[0];step.approvalRequired=false;step.status='rejected';step.display={operation:'timeline.clip.update',targets:[{kind:'timeline_clip',id:stepId,name:'clips/a.mp4'}],targetCount:1,fields:[{targetIndex:0,property:'gainDb',unit:'db',after:-20,current:-8}]};h.state.snapshot!.run.skippedTargets=[{stepId:step.id,target:{kind:'timeline_clip',id:stepId,revision:4},createdAt:'2026-10-22T00:00:00.000Z'}];h.render();let row=h.find('agent-task-skipped'),text=renderedText(row);assert.ok(text.includes('a.mp4'));assert.ok(!text.includes('clips/'));assert.ok(text.includes('-8.0 dB'));assert.ok(!text.includes('-20'));assert.equal(nodes(row).some((node)=>node.type==='button'),false);assert.equal(h.find('agent-task-undo-all')!.props.disabled,true);assert.ok(renderedText(h.render()[0]).includes(translate(locale,'agent.panel.roundChanges',{count:0})));assert.equal(h.state.snapshot!.changes.length,0);assert.ok(!text.includes(stepId));
      delete step.display.fields[0].current;h.render();row=h.find('agent-task-skipped');text=renderedText(row);assert.ok(!text.includes('-20'));assert.ok(!text.includes(translate(locale,'agent.panel.retainedValue',{value:''})));
      h.state.snapshot!.run.skippedTargets=[];h.render();assert.equal(h.find('agent-task-skipped'),undefined);
    }finally{h.unmount();}
  }
});


test('retry is bound to the last failed step and never offers an unknown result replay',()=>{
  for(const locale of ['zh-Hans','zh-Hant','en','ja'] as const)for(const kind of ['model','tool'] as const){
    const h=harness({status:'failed',locale});try{
      const step=h.state.snapshot!.steps[0];Object.assign(step,{kind,status:'failed',approvalRequired:false,error:{code:kind==='model'?'AGENT_CHAT_CONNECT_FAILED':'EXPORT_CAPABILITY_UNSUPPORTED',message:'NEVER_ECHO_PROVIDER_DETAIL'}});
      h.render();const retry=h.find(`agent-task-retry-${stepId}`);assert.ok(retry);assert.equal(retry.props.disabled,false);assert.ok(renderedText(retry).includes(translate(locale,'agent.panel.retry')));retry.props.onClick();assert.deepEqual(h.calls,[['retry',{stepId},'run']]);assert.ok(!renderedText(h.render()[0]).includes('NEVER_ECHO_PROVIDER_DETAIL'));
      for(const status of ['running','paused','interrupted','completed'] as const){h.state.snapshot!.run.status=status;h.render();assert.equal(h.find(`agent-task-retry-${stepId}`),undefined);}
      h.state.snapshot!.run.status='failed';step.status='unknown';h.render();assert.equal(h.find(`agent-task-retry-${stepId}`),undefined);
      step.status='failed';h.state.snapshot!.steps.push({...step,id:'later-step',status:'completed'});h.render();assert.equal(h.find(`agent-task-retry-${stepId}`),undefined);
      h.state.snapshot!.steps.at(-1)!.status='unknown';h.render();assert.equal(h.find(`agent-task-retry-${stepId}`),undefined);
    }finally{h.unmount();}
  }
});

test('undo preview lists server-proven chain candidates and retained changes and confirms only explicitly',async()=>{
  for(const locale of ['zh-Hans','zh-Hant','en','ja'] as const){
    const changes=[
      {id:'modified',operation:'shot.update',targets:[],reversible:true,status:'applied',modifiedAfter:true,undoDisposition:'retain',display:{operation:'shot.update',targets:[{kind:'shot',id:stepId,name:'User kept this scene'}],targetCount:1,fields:[]}},
      {id:'chain',operation:'shot.update',targets:[],reversible:true,status:'applied',modifiedAfter:true,undoDisposition:'undo',display:{operation:'shot.update',targets:[{kind:'shot',id:stepId,name:'Undo this chain'}],targetCount:1,fields:[]}},
      {id:'undone',operation:'shot.create',targets:[],reversible:true,status:'reverted',undoDisposition:'retain'},
      {id:'paid',operation:'generation.submit',targets:[],reversible:false,status:'applied',undoDisposition:'retain'}
    ];
    const h=harness({status:'completed',changes,locale});try{
      h.render();assert.equal(h.find('agent-task-undo-modified')!.props.disabled,true);assert.equal(h.find('agent-task-undo-chain')!.props.disabled,true);assert.equal(renderedText(h.find('agent-task-modified-modified')),translate(locale,'agent.panel.modifiedAfter'));
      await h.find('agent-task-undo-all')!.props.onClick({currentTarget:{focus(){}}});await new Promise(resolve=>setImmediate(resolve));h.render();
      assert.ok(renderedText(h.find('agent-task-undo-list')).includes('Undo this chain'));assert.ok(!renderedText(h.find('agent-task-undo-list')).includes('User kept this scene'));assert.ok(renderedText(h.find('agent-task-keep-list')).includes('User kept this scene'));assert.ok(renderedText(h.find('agent-task-keep-list')).includes(translate(locale,'agent.task.reverted')));assert.equal(renderedText(h.find('agent-task-undo-confirm')).trim(),translate(locale,'agent.panel.undoCount',{count:1}));assert.deepEqual(h.calls,[['refreshRound','run']]);
      h.find('agent-task-undo-cancel')!.props.onClick();h.render();assert.equal(h.find('agent-task-undo-dialog'),undefined);assert.deepEqual(h.calls,[['refreshRound','run']]);
      await h.find('agent-task-undo-all')!.props.onClick({currentTarget:{focus(){}}});await new Promise(resolve=>setImmediate(resolve));h.render();h.find('agent-task-undo-confirm')!.props.onClick();assert.deepEqual(h.calls.at(-1),['undo_all',{undoChangeIds:['chain']},'run']);
    }finally{h.unmount();}
  }
});

test('zero-count and stale undo previews cannot confirm or silently adopt later changes',async()=>{
  for(const disposition of ['retain','blocked',undefined] as const){
    const h=harness({status:'completed',changes:[{id:'kept',operation:'shot.update',targets:[],reversible:true,status:'applied',modifiedAfter:true,undoDisposition:disposition}]});try{
      h.render();assert.equal(h.find('agent-task-undo-all')!.props.disabled,false);h.find('agent-task-undo-all')!.props.onClick({currentTarget:{focus(){}}});await new Promise(resolve=>setImmediate(resolve));h.render();assert.equal(h.find('agent-task-undo-confirm')!.props.disabled,true);assert.ok(h.find('agent-task-undo-empty'));h.find('agent-task-undo-confirm')!.props.onClick();assert.deepEqual(h.calls,[['refreshRound','run']]);
    }finally{h.unmount();}
  }
  const h=harness({status:'completed',changes:[{id:'eligible',operation:'shot.update',targets:[],reversible:true,status:'applied',undoDisposition:'undo'}]});try{
    h.state.snapshot!.run.revision=1;h.render();h.find('agent-task-undo-all')!.props.onClick({currentTarget:{focus(){}}});await new Promise(resolve=>setImmediate(resolve));h.render();const next=structuredClone(h.state.snapshot!);next!.run.revision=2;h.state.snapshot=next;h.state.rounds=[next];h.render();assert.equal(h.find('agent-task-undo-confirm')!.props.disabled,true);h.find('agent-task-undo-confirm')!.props.onClick();assert.deepEqual(h.calls,[['refreshRound','run']]);
  }finally{h.unmount();}
});


test('stale preflight failures explain the required recheck in every locale without suggesting settings changes',()=>{
  assert.equal(agentTaskErrorKey('PREFLIGHT_STALE'),'agent.task.error.preflightStale');
  for(const locale of ['zh-Hans','zh-Hant','en','ja'] as const){
    const h=harness({status:'failed',locale});try{
      const step=h.state.snapshot!.steps[0];Object.assign(step,{status:'failed',approvalRequired:false,error:{code:'PREFLIGHT_STALE',message:'PRIVATE_PREFLIGHT_DETAILS'}});h.render();
      assert.equal(renderedText(h.find(`agent-task-step-error-${stepId}`)),translate(locale,'agent.panel.failureReason',{reason:translate(locale,'agent.task.error.preflightStale')}));assert.ok(h.find(`agent-task-retry-${stepId}`));assert.equal(h.find(`agent-task-error-settings-${stepId}`),undefined);assert.ok(!renderedText(h.render()[0]).includes('PRIVATE_PREFLIGHT_DETAILS'));
    }finally{h.unmount();}
  }
});


test('changing project during undo preflight clears loading and a late response cannot reopen its dialog',async()=>{
  const changes=[{id:'eligible',operation:'shot.update',targets:[],reversible:true,status:'applied',undoDisposition:'undo'}];
  const h=harness({status:'completed',changes});let resolve;const held=new Promise(done=>{resolve=done;});
  try{
    h.setRefresh(held);h.render();h.find('agent-task-undo-all')!.props.onClick({currentTarget:{focus(){}}});h.render();assert.equal(h.find('agent-task-undo-all')!.props.disabled,true);
    h.setProject('44444444-4444-4444-8444-444444444444');h.render();h.render();assert.equal(h.find('agent-task-undo-all')!.props.disabled,false);
    resolve!(h.state.snapshot);await new Promise(done=>setImmediate(done));h.render();assert.equal(h.find('agent-task-undo-dialog'),undefined);assert.equal(h.find('agent-task-undo-all')!.props.disabled,false);assert.ok(!h.calls.some(call=>call[0]==='undo_all'));
    h.setRefresh(null);h.find('agent-task-undo-all')!.props.onClick({currentTarget:{focus(){}}});await new Promise(done=>setImmediate(done));h.render();assert.ok(h.find('agent-task-undo-dialog'));assert.equal(h.find('agent-task-undo-confirm')!.props.disabled,false);
  }finally{h.unmount();}
});

test('a same-revision target change invalidates the reviewed undo projection without selecting another round',async()=>{
 const h=harness({status:'completed',changes:[{id:'eligible',operation:'shot.update',targets:[],reversible:true,status:'applied',modifiedAfter:false,undoDisposition:'undo'}]});
 try{
  h.state.snapshot!.run.revision=3;h.render();h.find('agent-task-undo-all')!.props.onClick({currentTarget:{focus(){}}});await new Promise(done=>setImmediate(done));h.render();
  const changed=structuredClone(h.state.snapshot!);changed!.changes[0].modifiedAfter=true;changed!.changes[0].undoDisposition='retain';h.state.rounds=[changed];h.state.snapshot=changed;h.render();assert.equal(h.find('agent-task-undo-confirm')!.props.disabled,true);h.find('agent-task-undo-confirm')!.props.onClick();assert.deepEqual(h.calls,[['refreshRound','run']]);
 }finally{h.unmount();}
});


test('undo preview for an earlier round keeps the latest round selected and submits only the reviewed round',async()=>{
 const h=harness({status:'completed',changes:[{id:'old-change',operation:'shot.update',targets:[],reversible:true,status:'applied',undoDisposition:'undo'}]});
 try{
  const earlier=structuredClone(h.state.snapshot!);earlier!.run.id='earlier-round';earlier!.run.revision=7;earlier!.run.text='Earlier request';h.state.rounds=[earlier,h.state.snapshot!];
  h.render();h.find('agent-task-undo-all')!.props.onClick({currentTarget:{focus(){}}});await new Promise(done=>setImmediate(done));h.render();assert.equal(h.state.snapshot!.run.id,'run');assert.equal(h.find('agent-task-undo-confirm')!.props.disabled,false);h.find('agent-task-undo-confirm')!.props.onClick();assert.deepEqual(h.calls,[['refreshRound','earlier-round'],['undo_all',{undoChangeIds:['old-change']},'earlier-round']]);
 }finally{h.unmount();}
});
const question={question:'Which opening should Mio use?',options:[{label:'Wide street'},{label:'Close-up'}]};
const askStep=(status:string,result?:unknown):TaskPanelStep=>({id:stepId,kind:'tool',status,position:2,tier:'read_only',toolCall:{name:'mioon_ask',arguments:question},...(result!==undefined?{result}:{})});
test('a waiting question shows its card, makes the composer its answer box and moves stop to the status row',async()=>{
  const h=harness({status:'awaiting_answer'});try{
    h.state.snapshot!.steps=[askStep('awaiting_answer')];h.state.draft='Open on the harbour';
    const tree=h.render(),card=tree.find(node=>node.type==='question-card');assert.ok(card);assert.equal(card.props.state,'waiting');assert.equal(card.props.disabled,false);
    assert.equal(h.find('agent-task-draft')!.props.placeholder,translate('zh-Hans','agent.panel.question.answerDraft'));
    assert.equal(h.find('agent-task-attach')!.props.disabled,true,'an answer carries no attachments');
    assert.ok(h.find('agent-task-send'));assert.equal(h.find('agent-task-stop'),undefined,'the composer keeps sending; stop moves to the status row');
    h.find('agent-task-stop-question')!.props.onClick();assert.deepEqual(h.calls.at(-1),['stop',undefined,'run']);
    (card.props.onAnswer as (choices:number[],text?:string)=>unknown)([1]);assert.deepEqual(h.calls.at(-1),['answer',stepId,[1],undefined,'run']);
    h.render().find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(h.calls.at(-1),['answer',stepId,[],'Open on the harbour','run'],'typed text answers the waiting question');
    assert.equal(h.calls.some(call=>call[0]==='send'||call[0]==='note'),false);
  }finally{h.unmount();}
});
test('a stopped question stays in place, unanswered and read-only, and the composer returns to normal',()=>{
  const h=harness({status:'stopped'});try{
    h.state.snapshot!.steps=[askStep('awaiting_answer')];const card=h.render().find(node=>node.type==='question-card');assert.ok(card);assert.equal(card.props.state,'stopped');
    assert.equal(h.find('agent-task-stop-question'),undefined);assert.notEqual(h.find('agent-task-draft')!.props.placeholder,translate('zh-Hans','agent.panel.question.answerDraft'));
  }finally{h.unmount();}
});
test('an answered question collapses before the reply that followed it, and a later paid step still needs its approval',()=>{
  const h=harness({status:'awaiting_approval'});try{
    h.state.snapshot!.steps=[askStep('completed',{answer:{choices:[1]},selected:['Close-up']}),{id:'model-2',kind:'model',status:'completed',position:3,text:'Planning the close-up opening'},{id:'paid',kind:'tool',status:'awaiting_approval',position:4,tier:'paid',toolCall:{name:'mioon_generation_submit',arguments:{}}}];
    const tree=h.render(),row=tree.findIndex(node=>node.type==='answer-row'),reply=tree.findIndex(node=>node.props?.['data-testid']==='agent-task-reply');
    assert.ok(row>=0&&reply>row,'the answer precedes the reply that followed it');assert.equal(tree.some(node=>node.type==='question-card'),false);
    assert.ok(h.find('agent-task-answer-not-approval'));assert.ok(h.find('agent-task-approval-paid'));
    assert.ok(renderedText(tree.find(node=>node.props?.className==='mio-steps')).includes(translate('zh-Hans','agent.panel.question.answered')));
  }finally{h.unmount();}
});

