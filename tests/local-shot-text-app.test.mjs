import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const app=readFileSync(new URL('../apps/web/src/App.jsx',import.meta.url),'utf8');
function appFunction(start,end,env){
  const from=app.indexOf(start),to=app.indexOf(end,from+start.length);
  assert.ok(from>=0&&to>from,`actual App boundary ${start}`);
  return Function(...Object.keys(env),`return (${app.slice(from,to).trim()});`)(...Object.values(env));
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function navigation(){
  let serial=1,current=true,dirty=true,abandoned=0,resets=0;
  const held=deferred();
  const controller={capture:()=>serial,isCurrent:value=>value===serial,hasUnsaved:()=>dirty,abandonCurrentInput:value=>{if(value!==serial)return false;abandoned++;return true;}};
  const shotTextRef={current:controller};
  const guard=appFunction('async function guardNavigation(', 'async function guardProjectNavigation(',{
    context:()=>({projectId:'p'}),isCurrent:()=>current,shotTextRef,subtitlesRef:{current:null},clipDraftRef:{current:null},subjectsRef:{current:null},dirtyRef:{current:false},confirm:()=>held.promise,
    setShotDirty:()=>resets++,setClipDirty:()=>{},setSourceDirty:()=>{},setSubjectDirty:()=>{},setSubtitleDirty:()=>{},setInspectorEpoch:()=>{},
  });
  return{guard,held,shotTextRef,controller,newEdit:()=>serial++,leave:()=>current=false,clean:()=>dirty=false,counts:()=>({abandoned,resets})};
}

test('actual App navigation sees synchronous shot text edits before generic dirty effect and preserves stored intent',async()=>{
  const f=navigation(),pending=f.guard();assert.deepEqual(f.counts(),{abandoned:0,resets:0});f.held.resolve(true);assert.equal(await pending,true);
  assert.deepEqual(f.counts(),{abandoned:1,resets:1});
  assert.doesNotMatch(app.slice(app.indexOf('async function guardNavigation('),app.indexOf('async function guardProjectNavigation(')),/clearPending|transport\.|\.discardStored\(|\.recover\(/);
});
for(const change of ['edit','controller','project'])test(`actual App late confirmation cannot discard newer ${change} shot draft`,async()=>{
  const f=navigation(),pending=f.guard();if(change==='edit')f.newEdit();if(change==='controller')f.shotTextRef.current={...f.controller};if(change==='project')f.leave();f.held.resolve(true);
  assert.equal(await pending,false);assert.deepEqual(f.counts(),{abandoned:0,resets:0});
});
test('actual App cancelled navigation leaves shot draft untouched',async()=>{const f=navigation(),pending=f.guard();f.held.resolve(false);assert.equal(await pending,false);assert.deepEqual(f.counts(),{abandoned:0,resets:0});});

test('actual App live context preserves nontext pending fences and does not clear receipts',()=>{
  let entries=[],failed=false;const busy=new Set();const currentProject={current:'project-a'},projectEpoch={current:2},navigationEpoch={current:7},panelIntent={current:1};
  const context=appFunction('function shotTextContext()', 'async function saveShot(',{
    currentProject,projectEpoch,navigationEpoch,panelIntent,inspectorEpoch:4,workbenchReady:true,workspaceRef:{current:{restored:false}},online:true,auth:true,loading:false,
    pendingForProject:()=>{if(failed)throw Error('unreadable');return entries;},isMutationOperation:op=>op==='shot.update'||op==='node.update',REFERENCE_MUTATION_OPERATIONS:['reference.attach','reference.detach'],
    isBusy:key=>busy.has(key),tasksRef:{current:{blocked:()=>false}},
  });
  assert.equal(context().busy,false);assert.equal(context().scope,'project-a:2:4');
  for(const operation of ['shot.update','node.update','reference.attach','reference.detach']){entries=[{operation}];assert.equal(context().busy,true);assert.equal(entries.length,1);}
  entries=[];busy.add('canvas:mutation');assert.equal(context().busy,true);busy.clear();failed=true;assert.equal(context().busy,true);
  const source=app.slice(app.indexOf('function shotTextContext()'),app.indexOf('async function saveShot('));assert.doesNotMatch(source,/clearPending|forget|removeItem|\.execute\(/);
});

test('actual App shot fence blocks reference/generation work before touching legacy receipts',()=>{
  let checked=0,blocked=true;const notices=[];
  const guard=appFunction('function referenceWorkBlocked()', 'async function attachReference(',{
    shotTextRef:{current:{blocksLegacy:()=>blocked}},notify:(...args)=>notices.push(args),tasksRef:{current:{blocked:()=>{checked++;return false;}}},currentProject:{current:'p'},workspaceRef:{current:null},pendingForProject:()=>[],isMutationOperation:()=>false,isBusy:()=>false,hasPendingReference:()=>false,openTasks:()=>{},
  });
  assert.equal(guard(),true);assert.equal(checked,0);assert.match(notices[0][0],/文字/);blocked=false;assert.equal(guard(),false);assert.equal(checked,1);
});

test('actual App beforeunload reads synchronous shot state independently of legacy dirty flag',()=>{
  const from=app.indexOf('const warn = e =>'),to=app.indexOf("; window.addEventListener('beforeunload', warn)",from);assert.ok(from>=0&&to>from);
  let dirty=true,prevented=0;
  const warn=Function('dirtyRef','shotTextRef','clipDraftRef','timelineFormatRef','deliveryNameRef',`return (${app.slice(from+'const warn = '.length,to)});`)({current:false},{current:{hasUnsaved:()=>dirty}},{current:null},{current:null},{current:null});
  const event={preventDefault:()=>prevented++};warn(event);assert.equal(prevented,1);assert.equal(event.returnValue,'');dirty=false;warn(event);assert.equal(prevented,1);
});

test('actual App lifecycle drain waits on local shot persistence only, no business replay',async()=>{
  const from=app.indexOf('const drain = async () =>'),to=app.indexOf('\n    globalThis.__mioonFlushWorkspacePreferences = drain;',from);assert.ok(from>=0&&to>from);
  let saved=false,calls=0;
  const drain=Function('controller','workspaceRef','locator','localDeliveryRef','shotTextRef','clipDraftRef',`return (${app.slice(from+'const drain = '.length,to).trim().replace(/;$/,'')});`)({flush:async()=>{},hasUnsaved:()=>false},{current:{restored:false}},{flush:async()=>true},{current:null},{current:{hasUnpersisted:()=>true,flush:async()=>{calls++;return saved;}}},{current:null});
  assert.equal(await drain(),false);saved=true;assert.equal(await drain(),true);assert.equal(calls,2);
  assert.doesNotMatch(app.slice(from,to),/execute|recover|prepare|rpc\(/);
});

const inspector=readFileSync(new URL('../apps/web/src/Inspector.jsx',import.meta.url),'utf8');
function rebaseCallback({externalDuration=false}={}){
  const before={title:'Before',prompt:'Old prompt',duration:7,aspectRatio:'16:9',referenceAssetIds:[],parameters:{seed:42}};
  const shot={...before,title:'Confirmed text',revision:4,...(externalDuration?{duration:8}:{})};
  const baseline={current:structuredClone(before)},draftRef={current:{...before,title:'Confirmed text',duration:9}},baseRevisionRef={current:3},dirtyRef={current:true},editSerial={current:11},textVersion={current:2};
  const values={};let live=true;const capture={};
  const start=inspector.indexOf('onRebase: token => {'),end=inspector.indexOf('    onAccepted:',start);assert.ok(start>=0&&end>start);
  const source=inspector.slice(start+'onRebase: '.length,end).trim().replace(/,$/,'');
  const env={mounted:{current:true},shotText:{controller:{isCurrent:token=>live&&token===capture}},editable:value=>Object.fromEntries(Object.keys(before).map(key=>[key,value[key]])),shot,baseline,draftRef,baseRevisionRef,dirtyRef,editSerial,textVersion,
    same:(a,b)=>JSON.stringify(a)===JSON.stringify(b),setBaseRevision:value=>values.revision=value,setConflict:value=>values.conflict=value,setDirty:value=>values.dirty=value};
  return{run:Function(...Object.keys(env),`return (${source});`)(...Object.values(env)),capture,values,baseline,draftRef,baseRevisionRef,dirtyRef,stale:()=>live=false};
}
test('actual Inspector explicit text baseline alignment preserves local duration and original nontext fields',()=>{
  const f=rebaseCallback();assert.equal(f.run(f.capture),true);assert.equal(f.draftRef.current.duration,9);assert.equal(f.baseline.current.duration,7);assert.equal(f.baseRevisionRef.current,4);assert.equal(f.values.conflict,false);assert.equal(f.dirtyRef.current,true);assert.equal(f.values.dirty,true);
  assert.equal(f.baseline.current.title,'Confirmed text');assert.deepEqual(f.draftRef.current.parameters,{seed:42});
});
test('actual Inspector changed saved nontext forbids silently refreshing full-form revision',()=>{
  const f=rebaseCallback({externalDuration:true});assert.equal(f.run(f.capture),true);assert.equal(f.baseRevisionRef.current,3);assert.equal(f.values.conflict,true);assert.equal(f.draftRef.current.duration,9);assert.equal(f.baseline.current.duration,7);assert.equal(f.dirtyRef.current,true);
});
test('actual Inspector stale baseline callback cannot mutate any local form identity',()=>{
  const f=rebaseCallback(),before=structuredClone({baseline:f.baseline.current,draft:f.draftRef.current,revision:f.baseRevisionRef.current});f.stale();assert.equal(f.run(f.capture),false);assert.deepEqual({baseline:f.baseline.current,draft:f.draftRef.current,revision:f.baseRevisionRef.current},before);
});

function generationAdmission({restored=false,controller=true,target='shot-a',loading=false,pending=false}={}){
  const notices=[],sideEffects=[];
  const guard=appFunction('function checkGeneration(', 'const submitGeneration =',{
    generationUnavailableReason:'',workspaceRef:{current:{restored}},shotTextRef:{current:controller?{blocksLegacy:id=>loading||pending||Boolean(id&&id!==target)}:null},notify:message=>notices.push(message),referenceWorkBlocked:()=>false,
    generationInputIssue:()=>{sideEffects.push('input');return null;},providerAvailabilityIssue:()=>null,dataRef:{current:{assets:[],shots:[],jobs:[]}},referenceForShot:()=>null,openTasks:()=>{},
  });
  return{guard:(id='shot-b',frozen=false)=>guard({id}, {mock:true},'mock','text',frozen),notices,sideEffects};
}
for(const options of [{target:'shot-a'},{controller:false},{target:'shot-b',loading:true},{target:'shot-b',pending:true}])test(`actual fresh generation waits for its selected target registration/GET: ${JSON.stringify(options)}`,()=>{
  const f=generationAdmission(options);assert.equal(f.guard(),false);assert.equal(f.sideEffects.length,0);assert.match(f.notices[0],/文字|核对/);
});
test('actual fresh generation succeeds only after matching loaded target; frozen retry and restored fallback retain old admission',()=>{
  assert.equal(generationAdmission({target:'shot-b'}).guard(),true);
  assert.equal(generationAdmission({controller:false}).guard('historical-shot',true),true);
  assert.equal(generationAdmission({controller:false,restored:true}).guard(),true);
});
