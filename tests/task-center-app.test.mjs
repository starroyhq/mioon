import { createI18nTestContext, message } from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {captureTaskWorkspaceIntent, navigateTaskShot} from '../apps/web/src/task-workspace-intent.ts';

const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
function section(start, end) { const a=app.indexOf(start),b=app.indexOf(end,a);assert.ok(a>=0&&b>a);return app.slice(a,b); }
const bridge=section('  function readTaskRevealContext()', '  function openExportHistory()');
const runBody=section('  async function runDurable(', '  async function recoverTask(');
const recoverBody=section('  async function recoverTask(', '  async function adoptLegacyTask(');
const make=(code,deps,names)=>Function(...Object.keys(deps),`${code}\nreturn {${names.join(',')}};`)(...Object.values(deps));
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const projectId='11111111-1111-4111-8111-111111111111',shotId='22222222-2222-4222-8222-222222222222',jobId='33333333-3333-4333-8333-333333333333';
function harness() {
 const state={projectReady:true,overlay:'tasks',dock:'properties',page:'subtitle',mode:'editing',confirm:[],reveal:[],notice:[],auth:[],refresh:[],ack:[],busy:[],draft:{name:'unsaved',startFrame:7}};
 const refs={importSession:{current:{active:true}},viewReady:{current:true},taskWorkspaceState:{current:{visible:true,connected:true}},currentProject:{current:projectId},projectEpoch:{current:2},navigationEpoch:{current:3},panelIntent:{current:4},workspaceRef:{current:{id:'original'}},taskShotAttempt:{current:0},dataRef:{current:{project:{id:projectId},jobs:[{id:jobId,shotId,projectId,status:'succeeded'}],shots:[{id:shotId,projectId}],timelineHistory:{revision:1}}}};
 const deps={message,msg:message,...createI18nTestContext(),...refs,clipConnectionBlocked:{current:false},clipDraftRef:{current:null},markPanelIntent:()=>refs.panelIntent.current++,setShowDelivery:value=>{if(value)state.overlay='delivery';else if(state.overlay==='delivery')state.overlay=null;},setShowImage:value=>{if(value)state.overlay='image';else if(state.overlay==='image')state.overlay=null;},setShowTasks:value=>{if(value){state.overlay='tasks';state.reveal.push(['tasks',true]);}else if(state.overlay==='tasks')state.overlay=null;},projectSessionReady:()=>state.projectReady,captureTaskWorkspaceIntent,navigateTaskShot,workspaceOriginScope:w=>w.id,
  guardNavigation:async(message,extra,canDiscard)=>{state.confirm.push({message,extra,canDiscard});return canDiscard();},
  setRightDockTab:value=>{state.dock=typeof value==='function'?value(state.dock):value;},setPropertiesPage:value=>{state.page=value;},
  setPanelOpen:(...args)=>{state.reveal.push(args);refs.panelIntent.current++;},updateView:(section,value)=>{state.reveal.push([section,value]);if(section==='activeMode')state.mode=value;},
  context:()=>({projectId:refs.currentProject.current,epoch:refs.navigationEpoch.current}),isCurrent:c=>c.projectId===refs.currentProject.current&&c.epoch===refs.navigationEpoch.current,
  readableError:e=>e.message,isBusy:()=>false,markBusy:(...args)=>state.busy.push(args),pendingForProject:()=>[],
  requestCounter:{current:0},setData:fn=>{refs.dataRef.current=fn(refs.dataRef.current);},notify:(...args)=>state.notice.push(args),
  refresh:async id=>state.refresh.push(id),setAuth:value=>state.auth.push(value),setSubjectRefresh:()=>{},timelineFormatRef:{current:null},subtitlesRef:{current:null},
  tasksRef:{current:{submit:async()=>{throw Error('Set explicit submit fixture');},acknowledge:async task=>state.ack.push(task),recover:async()=>{throw Error('Set explicit recovery fixture');}}}};
 const methods=make(bridge+runBody+recoverBody,deps,['readTaskRevealContext','readTaskViewContext','captureTaskView','openTasks','inspectTaskJob','runDurable','recoverTask']);
 return {state,refs,deps,...methods,remake:()=>make(bridge+runBody+recoverBody,deps,['inspectTaskJob'])};
}

test('actual Tasks entry reveals its overlay without changing the dock, drafts or business state',()=>{
 const h=harness(),before=structuredClone(h.state.draft);h.state.dock='delivery';assert.equal(h.openTasks(),true);
 assert.equal(h.state.dock,'delivery');assert.equal(h.state.overlay,'tasks');assert.deepEqual(h.state.reveal,[['tasks',true]]);assert.deepEqual(h.state.draft,before);assert.equal(h.state.confirm.length,0);assert.equal(h.state.ack.length,0);
 const n=h.state.reveal.length;assert.equal(h.openTasks(()=>false),false);assert.equal(h.state.reveal.length,n);
});
test('actual Tasks view capture is separate from a generic delayed reveal capture',()=>{
 const h=harness();h.refs.taskWorkspaceState.current.visible=false;
 assert.equal(h.captureTaskView(),null);assert.equal(captureTaskWorkspaceIntent(h.readTaskRevealContext)(),true);
 h.refs.taskWorkspaceState.current.connected=false;assert.equal(captureTaskWorkspaceIntent(h.readTaskRevealContext),null);
});
test('a retained disconnected clip blocks durable dispatch and recovery before touching task state', async () => {
 const h=harness();h.deps.clipConnectionBlocked.current=true;
 assert.equal(await h.runDurable('timeline:mutation','timeline.track.update',{projectId}),null);
 assert.equal(await h.recoverTask({id:'task',projectId},false,()=>true),null);
 assert.deepEqual(h.state.busy,[]);assert.deepEqual(h.state.ack,[]);assert.deepEqual(h.state.refresh,[]);assert.deepEqual(h.state.notice,[]);
});
test('actual view-shot bridge reaches Properties and the fixed shot without using the old async inspect path',async()=>{
 const h=harness();assert.equal(await h.inspectTaskJob(h.refs.dataRef.current.jobs[0],()=>true),true);
 assert.equal(h.state.dock,'properties');assert.equal(h.state.page,'inspector');assert.equal(h.state.mode,'canvas');
 assert.deepEqual(h.state.reveal[0],['canvas',{selectedId:shotId,inspectorTab:'versions',highlightedVersionId:null}]);
 assert.equal(h.state.confirm.length,1);assert.equal(h.state.confirm[0].extra,false);assert.deepEqual(h.state.reveal.at(-1),['inspector',true,'canvas']);
});
for(const change of ['cancel','hidden','panel','project','workspace','job','shot','reboundJob'])test(`actual Tasks target guard preserves inputs when ${change} occurs during confirmation`,async()=>{
 const h=harness(),entered=gate(),release=gate();let discard=0;const before=structuredClone(h.state.draft);
 h.deps.guardNavigation=async(_message,_extra,canDiscard)=>{entered.resolve();await release.promise;if(change==='cancel'||!canDiscard())return false;discard++;return true;};
 const {inspectTaskJob}=h.remake();const pending=inspectTaskJob(h.refs.dataRef.current.jobs[0],()=>h.refs.taskWorkspaceState.current.visible);await entered.promise;
 if(change==='hidden')h.refs.taskWorkspaceState.current.visible=false;
 if(change==='panel')h.refs.panelIntent.current++;
 if(change==='project')h.refs.projectEpoch.current++;
 if(change==='workspace')h.refs.workspaceRef.current={id:'restored'};
 if(change==='job')h.refs.dataRef.current.jobs=[];
 if(change==='shot')h.refs.dataRef.current.shots=[];
 if(change==='reboundJob')h.refs.dataRef.current.jobs[0].shotId='other';
 release.resolve();assert.equal(await pending,false);assert.equal(discard,0);assert.equal(h.state.reveal.length,0);assert.deepEqual(h.state.draft,before);
});
test('actual newer Tasks shot choice invalidates earlier pending confirmation before discard',async()=>{
 const h=harness(),gates=[gate(),gate()],entered=[gate(),gate()];let calls=0,discard=0;
 const otherShot='44444444-4444-4444-8444-444444444444',otherJob={id:'55555555-5555-4555-8555-555555555555',shotId:otherShot,projectId,status:'failed'};
 h.refs.dataRef.current.jobs.push(otherJob);h.refs.dataRef.current.shots.push({id:otherShot,projectId});
 h.deps.guardNavigation=async(_message,_extra,current)=>{const i=calls++;entered[i].resolve();await gates[i].promise;if(!current())return false;discard++;return true;};
 const {inspectTaskJob}=h.remake(),first=inspectTaskJob(h.refs.dataRef.current.jobs[0],()=>true);await entered[0].promise;
 const second=inspectTaskJob(otherJob,()=>true);await entered[1].promise;gates[0].resolve();assert.equal(await first,false);assert.equal(discard,0);
 gates[1].resolve();assert.equal(await second,true);assert.equal(discard,1);assert.equal(h.state.reveal[0][1].selectedId,otherShot);
});
for(const operation of ['timeline.format.set','timeline.subtitle.add','subject.create'])test(`direct ${operation} runner cannot steal the dock after a delayed unknown result`,async()=>{
 const h=harness(),entered=gate(),release=gate(),input={projectId,requestId:'original-fixed-request'};
 h.deps.tasksRef.current.submit=async args=>{assert.equal(args.input,input);entered.resolve();await release.promise;return {task:{status:'unknown',input,projectId}};};
 const pending=h.runDurable('lane',operation,input);await entered.promise;h.refs.panelIntent.current++;h.state.dock='agent';release.resolve();
 assert.equal(await pending,null);assert.equal(h.state.dock,'agent');assert.equal(h.state.reveal.length,0);assert.equal(input.requestId,'original-fixed-request');
});
test('delayed unknown still reveals Tasks when the original view choice is current',async()=>{
 const h=harness();h.state.dock='properties';h.deps.tasksRef.current.submit=async()=>({task:{status:'unknown'}});
 assert.equal(await h.runDurable('lane','timeline.track.update',{projectId}),null);assert.equal(h.state.dock,'properties');assert.equal(h.state.overlay,'tasks');assert.equal(h.state.reveal.length,1);
});
test('already accepted exact result still acknowledges and refreshes after the user leaves Tasks',async()=>{
 const h=harness(),entered=gate(),release=gate(),task={id:'task',projectId,status:'applied',requestId:'original-key'},result={revision:12};
 h.deps.tasksRef.current.submit=async()=>{entered.resolve();await release.promise;return {task,result};};
 const pending=h.runDurable('lane','timeline.track.update',{projectId,requestId:task.requestId});await entered.promise;h.refs.panelIntent.current++;h.state.dock='delivery';release.resolve();
 assert.deepEqual(await pending,result);assert.deepEqual(h.state.ack,[task]);assert.deepEqual(h.state.refresh,[projectId]);assert.equal(h.state.dock,'delivery');assert.equal(h.state.reveal.length,0);
});
test('Tasks recovery lookup loses execution and notice authority when the pane hides',async()=>{
 const h=harness(),entered=gate(),release=gate();let current=true,executions=0;
 h.deps.tasksRef.current.recover=async(task,{canExecute})=>{entered.resolve();await release.promise;if(canExecute())executions++;return {task:{...task,status:'unknown'}};};
 const pending=h.recoverTask({id:'task',projectId},false,()=>current);await entered.promise;current=false;release.resolve();await pending;
 assert.equal(executions,0);assert.equal(h.state.notice.length,0);assert.equal(h.state.ack.length,0);assert.equal(h.state.busy.at(-1)[2],false);
});
test('Tasks recovery handles an applied receipt after hiding without rewriting drafts or opening panels',async()=>{
 const h=harness(),entered=gate(),release=gate(),task={id:'task',projectId,status:'applied',requestId:'fixed-key',lane:'timeline:mutation'},draft=structuredClone(h.state.draft);let current=true;
 h.deps.tasksRef.current.recover=async()=>{entered.resolve();await release.promise;return {task};};
 const pending=h.recoverTask(task,false,()=>current);await entered.promise;current=false;release.resolve();await pending;
 assert.deepEqual(h.state.ack,[task]);assert.deepEqual(h.state.refresh,[projectId]);assert.deepEqual(h.state.draft,draft);assert.equal(h.state.reveal.length,0);assert.equal(h.state.notice.length,0);
});

for(const changedProject of [false,true])test(`Tasks hidden recovery 401 retains authentication handling, changed project=${changedProject}`,async()=>{
 const h=harness(),entered=gate(),release=gate();let current=true;
 h.deps.tasksRef.current.recover=async()=>{entered.resolve();await release.promise;throw Object.assign(new Error('Session expired'),{code:'UNAUTHORIZED'});};
 const pending=h.recoverTask({id:'task',projectId},false,()=>current);await entered.promise;current=false;
 if(changedProject)h.refs.currentProject.current='another-project';release.resolve();await pending;
 assert.deepEqual(h.state.auth,changedProject?[]:[false]);assert.equal(h.state.notice.length,0);assert.equal(h.state.reveal.length,0);
 assert.equal(h.state.ack.length,0);assert.equal(h.state.busy.at(-1)[2],false);
});

test('paid retry keeps its Tasks review and rejects a revoked pane before submission',()=>{
 const code=section('  function retryGeneration(', '  async function createProject('),snapshot={title:'Fixed original',duration:4,aspectRatio:'16:9',referenceAssetIds:[]};
 const job={id:jobId,shotId,projectId,providerId:'synthetic-paid-adapter',model:'fixed-test-model',snapshot};
 const state={reviews:[],submitted:[],notices:[]},realConfirmRef={current:null};let viewCurrent=true;
 const deps={message,msg:message,...createI18nTestContext(),providers:[{id:job.providerId,mock:false}],checkGeneration:()=>true,reviewGeneration:null,
  dataRef:{current:{shots:[{id:shotId,projectId}],jobs:[job],assets:[]}},generationReviewScope:{current:{key:'tasks'}},realConfirmRef,
  setRealConfirm:value=>state.reviews.push(value),context:()=>({projectId,epoch:1}),isCurrent:()=>true,
  generationReferenceIdentity:()=> 'fixed-source',generationReferences:()=>({references:[]}),generationOptionsRef:{current:{}},generationSelection:()=>({}),
  subjectVideoIdentity:()=>null,subjectVideoProfileIdentity:()=>null,submitGeneration:args=>state.submitted.push(args),notify:message=>state.notices.push(message)};
 // reviewGeneration is declared by the actual extracted code, not a stub.
 delete deps.reviewGeneration;const h=make(code,deps,['retryGeneration','confirmGeneration']);h.retryGeneration(job,()=>viewCurrent);
 const approval=realConfirmRef.current;assert.ok(approval);assert.deepEqual(approval.shot,{...snapshot,id:shotId});assert.equal(approval.approvalView,deps.generationReviewScope.current);assert.equal(typeof approval.taskViewGuard,'function');
 viewCurrent=false;h.confirmGeneration(approval);assert.equal(state.submitted.length,0);assert.equal(state.notices.length,1);
 viewCurrent=true;h.retryGeneration(job,()=>viewCurrent);h.confirmGeneration(realConfirmRef.current);assert.equal(state.submitted.length,1);assert.equal(state.submitted[0].retryJobId,jobId);
});

test('actual App keeps retained owners mounted and routes task opening through its overlay',()=>{
 assert.doesNotMatch(app,/\bshowJobs\b|\bsetShowJobs\b/);assert.match(app+readFileSync(new URL('../apps/web/src/TaskPopover.tsx',import.meta.url),'utf8'),/right-dock-tab-tasks/);assert.match(app,/id="right-dock-tasks"[\s\S]*?<TaskCenter taskViewScope=/);
 assert.match(app,/onInspectJob=\{inspectTaskJob\}/);assert.match(app,/setShowTasks\(false\); setShowDelivery\(false\);/);
 for(const page of ['properties','agent','image','delivery','tasks'])assert.match(app,new RegExp(`id="right-dock-${page}"`));
 assert.match(app,/onReload=\{\(\) => tasksRef\.current\.load\(currentProject\.current\)\}/);
 assert.doesNotMatch(bridge,/\.execute\(|\.recover\(|\.acknowledge\(|\.load\(|\brpc\(|setInterval|setTimeout/);
});


test('home or a failed opening grants neither task observation nor delayed reveal authority',()=>{
 const h=harness();h.state.projectReady=false;assert.equal(h.readTaskRevealContext().active,false);assert.equal(h.captureTaskView(),null);assert.equal(captureTaskWorkspaceIntent(h.readTaskRevealContext),null);assert.equal(h.state.ack.length,0);assert.equal(h.state.reveal.length,0);
});
