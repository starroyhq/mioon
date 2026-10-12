import {getWorkspaceRestoreContext} from './workspace-restore-schema.mjs';
import {workspaceRestoreError} from './workspace-restore-policy.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {IMAGE_LIMITS,IMAGE_MODELS,IMAGE_FIXED_OPTIONS,IMAGE_MUTATION_OPERATIONS,IMAGE_UNRESOLVED_STATES,isImageMutationResponse} from '@mioon/contracts';
import {createImageHistoryReaders,imageServiceMessages as messages,imageServiceError as error} from './images/history.mjs';
import {createOwnedMediaGraphReader} from './inspection.mjs';
import {createImageEditSourceResolver,imageEditFields} from './images/edit-source.mjs';
import {createImageStorage} from './image-storage.mjs';
import {createMockImageAdapter} from './images/adapter.mjs';
import {validatePng} from './images/png.mjs';
import {ownsStoreLock} from './db.mjs';
import {awaitProvider,boundedShutdown} from './operation-lifecycle.mjs';
import {createImageReviewServices} from './images/reviews.mjs';
import {createLiveImageGateway,createCompatibleImageGateway} from './images/gateway.mjs';
import {IMAGE_SETTINGS_ASSERT_CURRENT,IMAGE_SETTINGS_READ_CURRENT} from './images/settings.mjs';
import {DEFAULT_IMAGE_CONFIGURATION,isCompleteCustomImageConfiguration,getCustomImageDestination} from '../../contracts/src/image-settings.mjs';
import {createComfyRemoteServices} from './comfy/remote.mjs';
import {COMFY_SETTINGS_ASSERT_CURRENT,COMFY_SETTINGS_READ_CURRENT} from './comfy/settings.mjs';
import {isCompleteComfyImageConfiguration,getComfyImageDestination} from '../../contracts/src/comfy-images.mjs';
import {IMAGE_REVIEW_DESTINATION} from '../../contracts/src/image-reviews.mjs';

const owners=new WeakMap();
const noop=()=>{};
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const now=()=>new Date().toISOString();
// Safe custom pre-dispatch diagnostics. A dispatched task always remains unknown.
const customPreDispatchCodes=new Set(['IMAGE_NETWORK_DENIED','IMAGE_CONNECTION_FAILED','IMAGE_TIMEOUT','IMAGE_DISPATCH_BLOCKED','IMAGE_SETTINGS_CONFLICT','IMAGE_SETTINGS_NOT_CONFIGURED','IMAGE_SETTINGS_DISABLED']);
export function safeImageServiceError(cause){const code=Object.hasOwn(messages,cause?.code)?cause.code:'IMAGE_STORAGE_FAILED';return {code,message:messages[code],status:Number.isInteger(cause?.status)&&cause.status>=400&&cause.status<=599?cause.status:503};}
const fail=(code,status)=>{throw error(code,status);};
const invalid=()=>fail('IMAGE_RECORD_INVALID');
const maxRevision=revision=>{if(!Number.isSafeInteger(revision)||revision>=Number.MAX_SAFE_INTEGER)fail('IMAGE_CAPACITY',507);};
const bounded=(name,size,nullable=false)=>`CASE WHEN ${nullable?`${name} IS NULL OR `:''}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${size}) THEN ${name} ELSE 0 END AS ${name}`;
const defaultGenerate=createMockImageAdapter().generate;

/** Image-specific durable lifecycle. No chat/tool authority and no generic
 * operation dispatch. Live images require dedicated settings and immutable
 * user approval; injected dependencies are trusted tests, never RPC options. */
export function createImageServices(store,{signal:ownerSignal,generate=defaultGenerate,autoRun=true,fault=noop,settings,liveGateway,customSettings,customGateway,comfySettings,comfyConnector}={}){
 if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();
 const old=owners.get(store.db);
 if(old){if(old.root!==store.root||old.signal!==ownerSignal||old.generate!==generate||old.autoRun!==autoRun||old.fault!==fault||old.settings!==settings||old.liveGateway!==liveGateway||old.customSettings!==customSettings||old.customGateway!==customGateway||old.comfySettings!==comfySettings||old.comfyConnector!==comfyConnector)fail('IMAGE_SERVICE_ACTIVE');return old.service;}
 const {db,tx}=store,queue=[],pending=new Map(),active=new Set();
 const controller=new AbortController(),signal=ownerSignal?AbortSignal.any([ownerSignal,controller.signal]):controller.signal;
 let stopped=false,running=false,reconciled=false,reported=false;
 const selectedSettings=providerId=>providerId==='openai'?settings:providerId==='openai-compatible'?customSettings:providerId==='comfy-local'?comfySettings:null;
 const expectedSettings=(revision,configuration)=>({expectedRevision:revision,configuration:configuration??{...DEFAULT_IMAGE_CONFIGURATION,enabled:true}});
 const reviews=createImageReviewServices(store,{signal,fault,
  getSettings:providerId=>{const engine=selectedSettings(providerId);if(!engine)return {revision:0,enabled:false,destination:providerId==='openai'?IMAGE_REVIEW_DESTINATION:null};const current=engine[providerId==='comfy-local'?COMFY_SETTINGS_READ_CURRENT:IMAGE_SETTINGS_READ_CURRENT]();if(providerId==='comfy-local')return {revision:current.revision,enabled:current.configuration.enabled&&current.readiness.checked,destination:isCompleteComfyImageConfiguration(current.configuration)?getComfyImageDestination(current.configuration.baseUrl):null,configuration:current.configuration};return {revision:current.revision,enabled:current.configuration.enabled,destination:providerId==='openai'?IMAGE_REVIEW_DESTINATION:isCompleteCustomImageConfiguration(current.configuration)?getCustomImageDestination(current.configuration.baseUrl):null,...(providerId==='openai-compatible'?{configuration:current.configuration}:{})};},
  assertSettings:({revision,configuration},providerId)=>{const engine=selectedSettings(providerId);if(!engine)fail('IMAGE_LIVE_DISABLED',403);return engine[providerId==='comfy-local'?COMFY_SETTINGS_ASSERT_CURRENT:IMAGE_SETTINGS_ASSERT_CURRENT](expectedSettings(revision,configuration));}});
 const live=liveGateway??(settings?createLiveImageGateway({settings}):null);
 const compatible=customGateway??(customSettings?createCompatibleImageGateway({settings:customSettings}):null);
 const selectedGateway=providerId=>providerId==='openai'?live:providerId==='openai-compatible'?compatible:providerId==='comfy-local'?comfyConnector:null;
 const history=createImageHistoryReaders(store),{schemaPresent,project,reader,task,group,reviewBinding,prior}=history;
 const storage=createImageStorage(store,{validatePng}),editSources=createImageEditSourceResolver(store,{signal});
 function owner(){if(stopped||signal.aborted)fail('IMAGE_SERVICE_STOPPED',503);if(!ownsStoreLock(store))fail('IMAGE_OWNER_REQUIRED',403);}
 function current(original,{allowStopped=false}={}){
  if(!allowStopped)owner();else if(!ownsStoreLock(store))fail('IMAGE_OWNER_REQUIRED',403);
  const value=task(original.row.projectId,original.row.id,{shallow:true});
  if(value.row.revision!==original.row.revision||value.row.state!==original.row.state||value.row.inputHash!==original.row.inputHash||value.row.input!==original.row.input||value.row.snapshot!==original.row.snapshot)fail('IMAGE_REVISION_CONFLICT');
  return value;
 }
 function change(original,patch,{release=false,headVersionId,allowStopped=false}={}){
  const value=current(original,{allowStopped});maxRevision(value.row.revision);
  const allowed=['state','dispatched','stagedReceipt','versionId','errorCode'];if(Object.keys(patch).some(key=>!allowed.includes(key)))throw Error('Invalid internal image patch');
  const entries=Object.entries(patch),timestamp=now();
  const result=db.prepare(`UPDATE image_tasks SET ${entries.map(([key])=>`${key}=?`).join(',')},revision=revision+1,updatedAt=? WHERE id=? AND projectId=? AND revision=?`).run(...entries.map(([,v])=>v),timestamp,value.row.id,value.row.projectId,value.row.revision);if(result.changes!==1)fail('IMAGE_REVISION_CONFLICT');
  if(release){const g=reader(value.row.projectId).group(value.row.groupId);maxRevision(g.revision);if(g.activeTaskId!==value.row.id)invalid();db.prepare('UPDATE image_groups SET activeTaskId=NULL,headVersionId=?,revision=revision+1,updatedAt=? WHERE id=? AND projectId=? AND revision=?').run(headVersionId??g.headVersionId,timestamp,g.id,g.projectId,g.revision);}
  return task(value.row.projectId,value.row.id,{shallow:true});
 }
 const count=(table,where,args,cap)=>db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${table}${where?' WHERE '+where:''} LIMIT ?)`).get(...args,cap+1).n;
 function capacity(projectId,generating){
  if(count('image_requests','',[],IMAGE_LIMITS.requestsGlobal)>=IMAGE_LIMITS.requestsGlobal||count('image_requests','projectId=?',[projectId],IMAGE_LIMITS.requestsPerProject)>=IMAGE_LIMITS.requestsPerProject)fail('IMAGE_CAPACITY',507);
  if(!generating)return;
  if(count('image_tasks','',[],IMAGE_LIMITS.tasksGlobal)>=IMAGE_LIMITS.tasksGlobal||count('image_tasks','projectId=?',[projectId],IMAGE_LIMITS.tasksPerProject)>=IMAGE_LIMITS.tasksPerProject)fail('IMAGE_CAPACITY',507);
  const work="state IN ('queued','dispatching','receiving','persisting')";
  if(count('image_tasks',work,[],IMAGE_LIMITS.queuedGlobal)>=IMAGE_LIMITS.queuedGlobal||count('image_tasks',work+' AND projectId=?',[projectId],IMAGE_LIMITS.queuedPerProject)>=IMAGE_LIMITS.queuedPerProject)fail('IMAGE_QUEUE_FULL');
 }
 function accept(operation,input,approval,verified){
  owner();project(input.projectId);const original=prior(operation,input);if(original){if(approval)reviews.verifyReplay(input,original.id,approval);return {response:original,replayed:true};}
  if(verified)editSources.assertOwned(operation==='image.generate'?input:task(input.projectId,input.taskId,{shallow:true}).input,verified.descriptor);
  capacity(input.projectId,operation==='image.generate');
  let value;
  if(operation==='image.generate'){
   if(input.providerId!=='mock'){const engine=selectedSettings(input.providerId);if(!engine||!selectedGateway(input.providerId))fail('IMAGE_LIVE_DISABLED',403);if(!approval){const configured=engine[input.providerId==='comfy-local'?COMFY_SETTINGS_READ_CURRENT:IMAGE_SETTINGS_READ_CURRENT]();if(!configured.configuration.enabled||(input.providerId==='comfy-local'?!configured.readiness.checked:!configured.secret.configured))fail('IMAGE_LIVE_DISABLED',403);fail('IMAGE_REVIEW_REQUIRED',403);}}
   const id=randomUUID(),timestamp=now();let groupId;
   if(input.groupId){const g=group(input.projectId,input.groupId);if(g.revision!==input.expectedRevision)fail('IMAGE_REVISION_CONFLICT');if(g.activeTaskId!==null)fail('IMAGE_GROUP_BUSY');if(g.name!==input.name)fail('IMAGE_STATE_CONFLICT');maxRevision(g.revision);groupId=g.id;db.prepare('UPDATE image_groups SET activeTaskId=?,revision=revision+1,updatedAt=? WHERE id=? AND projectId=? AND revision=?').run(id,timestamp,g.id,g.projectId,g.revision);}
   else{groupId=randomUUID();db.prepare('INSERT INTO image_groups(id,projectId,name,revision,headVersionId,activeTaskId,createdAt,updatedAt) VALUES(?,?,?,1,NULL,?,?,?)').run(groupId,input.projectId,input.name,id,timestamp,timestamp);}
   const snapshot={schemaVersion:1,projectId:input.projectId,groupId,taskId:id,name:input.name,prompt:input.prompt,providerId:input.providerId,model:input.model,options:input.options,...(input.purpose==='edit'?{purpose:'edit',inputImage:input.inputImage,sourceImage:verified.descriptor}:{})};
   db.prepare("INSERT INTO image_tasks(id,projectId,groupId,requestId,inputHash,input,snapshot,state,revision,dispatched,stagedReceipt,versionId,errorCode,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,'queued',1,0,NULL,NULL,NULL,?,?)").run(id,input.projectId,groupId,input.requestId,hash(input),canonical(input),canonical(snapshot),timestamp,timestamp);
   if(input.providerId!=='mock')reviews.authorizeAcceptance(input,id,approval,verified);
   if(input.providerId==='comfy-local')remote.prepareTask(input.projectId,id);
   value=task(input.projectId,id).dto;
  }else{
   const target=task(input.projectId,input.taskId,{shallow:operation==='image.task.cancelQueued'});reviewBinding(target);if(target.row.revision!==input.expectedRevision)fail('IMAGE_REVISION_CONFLICT');
   if(operation==='image.task.cancelQueued'){
    if(!['queued','interrupted_before_dispatch'].includes(target.row.state)||target.dto.dispatched)fail('IMAGE_STATE_CONFLICT');
    value=change(target,{state:'cancelled_before_dispatch',errorCode:null},{release:true}).dto;
   }else{
    if(!['local_result_error','outcome_unknown'].includes(target.row.state))fail('IMAGE_STATE_CONFLICT');
    const receipt=target.receipt??storage.readReceipt({...target.row,snapshot:target.snapshot});if(!receipt)fail('IMAGE_RESULT_INVALID');
    value=change(target,{state:'persisting',stagedReceipt:target.row.stagedReceipt??canonical(receipt),errorCode:null}).dto;
   }
  }
  if(!isImageMutationResponse(operation,input,value))invalid();fault('before_request_receipt',{operation,input});
  db.prepare('INSERT INTO image_requests(requestId,operation,projectId,inputHash,canonicalInput,response) VALUES(?,?,?,?,?,?)').run(input.requestId,operation,input.projectId,hash(input),canonical(input),JSON.stringify(value));
  return {response:value,replayed:false};
 }
 // Async edit preflights cannot prove durable nonacceptance from a missing row.
 // Keep their original key; only the existing synchronous legacy refusal path
 // emits operation-bound absence evidence.
 const proofCodes=new Set(['IMAGE_LIVE_DISABLED','IMAGE_REVIEW_REQUIRED','IMAGE_CAPACITY','IMAGE_QUEUE_FULL','IMAGE_GROUP_BUSY','IMAGE_REVISION_CONFLICT','IMAGE_STATE_CONFLICT','IMAGE_RESULT_INVALID']);
 function notAccepted(cause,operation,input){
  if(input.purpose!=='edit'&&proofCodes.has(cause.code)&&!db.isTransaction){try{project(input.projectId);if(input.taskId)task(input.projectId,input.taskId);if(input.groupId)group(input.projectId,input.groupId);if(!db.prepare('SELECT 1 FROM image_requests WHERE requestId=?').get(input.requestId))cause.details={imageOutcome:{status:'not_accepted',projectId:input.projectId,operation,requestId:input.requestId,inputHash:hash(input)}};}catch{}}
 }
 function mutate(operation,input,approval,verified){
  if(Buffer.byteLength(canonical(input))>IMAGE_LIMITS.inputBytes)fail('IMAGE_CAPACITY',507);
  let accepted;
  try{accepted=tx(()=>accept(operation,input,approval,verified));}
  catch(cause){
   if(!verified)notAccepted(cause,operation,input);
   throw cause;
  }
  const value=accepted.response;
  if(!accepted.replayed){fault('after_acceptance',{operation,input,response:value});
   if(operation!=='image.task.cancelQueued')enqueue(value.id,input.projectId,operation==='image.task.recoverResult');}
  return value;
 }
 function mutateWithSource(operation,input,approval){
  if(operation==='image.task.cancelQueued'||operation==='image.generate'&&input.purpose!=='edit')return mutate(operation,input,approval);
  owner();project(input.projectId);const replay=prior(operation,input);
  if(replay){if(approval)reviews.verifyReplay(input,replay.id,approval);return replay;}
  const target=operation==='image.generate'?null:task(input.projectId,input.taskId),generation=target?.input??input;
  if(generation.purpose!=='edit')return mutate(operation,input,approval);
  const expected=target?.snapshot.sourceImage??(approval?reviews.sourceForApproval(approval):undefined);
  return editSources.verify(generation,expected).then(verified=>{editSources.assertCurrent(generation,verified);return mutate(operation,input,approval,verified);});
 }
 function diagnose(){if(!reported){reported=true;console.error('Skipped invalid local image record.');}}
 function stageTask(value){return {...value.row,snapshot:value.snapshot};}
 async function finalize(original){
  const target=current(original),receipt=target.receipt;reviewBinding(target);if(!receipt)fail('IMAGE_RESULT_INVALID');
  const source=target.input.purpose==='edit'?await editSources.verify(target.input,target.snapshot.sourceImage):null;
  const check=()=>{const latest=current(target);if(source)editSources.assertCurrent(latest.input,source);return latest;};
  const file=await storage.publish(stageTask(target),receipt,check);check();fault('after_media_publication',{taskId:target.row.id});
  check();
  const result=tx(()=>{
   const latest=current(target);if(source)editSources.assertOwned(latest.input,source.descriptor);const g=group(latest.row.projectId,latest.row.groupId);if(g.activeTaskId!==latest.row.id)invalid();
   const maximum=db.prepare('SELECT max(number) AS n FROM image_versions WHERE groupId=?').get(g.id).n??0;maxRevision(maximum);const timestamp=now();
   const asset={id:receipt.assetId,projectId:g.projectId,name:`${g.name} · 图像 ${maximum+1}.png`,mimeType:'image/png',sha256:receipt.sha256,width:receipt.width,height:receipt.height,sizeBytes:receipt.byteLength,relativePath:file.relativePath,url:`/media/${receipt.assetId}`,provenance:receipt.isMock?'synthetic-mock':'generated',createdAt:timestamp};
   const version={id:receipt.versionId,projectId:g.projectId,groupId:g.id,taskId:latest.row.id,number:maximum+1,assetId:asset.id,sha256:receipt.sha256,mimeType:'image/png',width:receipt.width,height:receipt.height,byteLength:receipt.byteLength,isMock:receipt.isMock,providerId:latest.snapshot.providerId,model:latest.snapshot.model,options:latest.snapshot.options,...imageEditFields(latest.snapshot),createdAt:timestamp};
   db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(asset.id,asset.projectId,JSON.stringify(asset));
   db.prepare('INSERT INTO image_versions(id,projectId,groupId,taskId,number,assetId,data) VALUES(?,?,?,?,?,?,?)').run(version.id,g.projectId,g.id,latest.row.id,version.number,asset.id,JSON.stringify(version));
   const completed=change(latest,{state:'succeeded',versionId:version.id,errorCode:null},{release:true,headVersionId:version.id});
   createOwnedMediaGraphReader(db,g.projectId).asset(asset.id);fault('before_result_commit',{taskId:latest.row.id});return completed;
  });
  try{storage.discardStagedPng(stageTask(result),()=>current(result));}catch{/* A retained private stage is safe; never undo a committed result. */}
 }
 const remote=createComfyRemoteServices(store,{signal,owner,readTask:task,readReview:reviews.getForTask,connector:comfyConnector,fault,
  failTask:target=>change(target,{state:'failed',errorCode:'COMFY_EXECUTION_FAILED'},{release:true}),
  stageResult:async(target,candidate,claim)=>{
   let original=current(target);const check=()=>{claim();return current(original);};
   try{check();const receipt=await storage.stage(stageTask(original),candidate,check);fault('after_result_manifest',{taskId:original.row.id});
    original=tx(()=>{check();return change(original,{state:'persisting',stagedReceipt:canonical(receipt),errorCode:null});});fault('after_result_receipt',{taskId:original.row.id});await finalize(original);
   }catch(cause){try{const checked=current(original,{allowStopped:true});claim();let receipt=checked.receipt;try{receipt??=storage.readReceipt(stageTask(checked));}catch{}tx(()=>{claim();if(receipt)change(checked,{state:'local_result_error',stagedReceipt:checked.row.stagedReceipt??canonical(receipt),errorCode:'IMAGE_RESULT_INVALID'},{allowStopped:true});else if(checked.row.state!=='outcome_unknown')change(checked,{state:'outcome_unknown',errorCode:'IMAGE_OUTCOME_UNKNOWN'},{allowStopped:true});});}catch{}throw cause;}
  }});
 async function execute(entry){
  let original;
  try{
   owner();original=task(entry.projectId,entry.id,{shallow:true});reviewBinding(original);
   if(entry.local){if(original.row.state!=='persisting')return;await finalize(original);return;}
   if(original.row.state!=='queued')return;
   const projection={providerId:original.snapshot.providerId,model:original.snapshot.model,prompt:original.snapshot.prompt,options:original.snapshot.options,...imageEditFields(original.snapshot)};
   const liveReview=projection.providerId!=='mock'?reviews.getForTask(entry.projectId,entry.id):null;
   const gateway=selectedGateway(projection.providerId);
   if(liveReview&&!gateway)fail('IMAGE_LIVE_DISABLED',403);
   const source=original.input.purpose==='edit'?await editSources.verify(original.input,original.snapshot.sourceImage):null;
   const dispatch=()=>{if(source)editSources.assertCurrent(original.input,source);original=tx(()=>{current(original);if(source)editSources.assertOwned(original.input,source.descriptor);if(liveReview)reviews.beforeDispatch(original.input,original.row.id);const changed=change(original,{state:'dispatching',dispatched:1,errorCode:null});if(projection.providerId==='comfy-local')remote.beforeSubmit(entry.projectId,entry.id);return changed;});fault('after_dispatch_fence',{taskId:original.row.id});};
   if(projection.providerId==='comfy-local'){
    await awaitProvider(()=>comfyConnector.submit({execution:liveReview.execution,config:liveReview.configuration,signal,beforeSubmit:dispatch}),signal,{submit:true});
    current(original);tx(()=>{remote.submitted(entry.projectId,entry.id);original=change(original,{state:'receiving',errorCode:null});});return;
   }
   const result=await awaitProvider(()=>liveReview?gateway.generate(projection,{signal,beforeDispatch:dispatch,...(source?{sourceBytes:source.bytes}:{}),settingsRevision:liveReview.settingsRevision,...(projection.providerId==='openai-compatible'?{configuration:liveReview.configuration}:{})}):generate(projection,{signal,beforeDispatch:dispatch,...(source?{sourceBytes:source.bytes}:{})}),signal,{submit:true});
   current(original);if(original.row.state!=='dispatching'||!original.dto.dispatched)invalid();
   const receipt=await storage.stage(stageTask(original),result,()=>current(original));fault('after_result_manifest',{taskId:original.row.id});
   original=tx(()=>change(original,{state:'persisting',stagedReceipt:canonical(receipt),errorCode:null}));fault('after_result_receipt',{taskId:original.row.id});
   await finalize(original);
  }catch(cause){
   if(!original)return;
   try{
    // A failed ownership/revision fence never authorizes another row write.
    const checked=current(original,{allowStopped:true});reviewBinding(checked);
    let receipt=checked.receipt;try{receipt??=storage.readReceipt(stageTask(checked));}catch{}
    tx(()=>{
     if(checked.input.providerId==='comfy-local'&&checked.dto.dispatched)remote.submissionUnknown(checked.row.projectId,checked.row.id);
     if(receipt)change(checked,{state:'local_result_error',stagedReceipt:checked.row.stagedReceipt??canonical(receipt),errorCode:'IMAGE_RESULT_INVALID'},{allowStopped:true});
     else if(checked.dto.dispatched)change(checked,{state:'outcome_unknown',errorCode:'IMAGE_OUTCOME_UNKNOWN'},{allowStopped:true});
     else if(stopped||signal.aborted)change(checked,{state:'interrupted_before_dispatch',errorCode:'IMAGE_INTERRUPTED'},{allowStopped:true});
     else change(checked,{state:'failed',errorCode:messages[cause.code]||checked.snapshot.providerId==='openai-compatible'&&customPreDispatchCodes.has(cause.code)?cause.code:'IMAGE_STORAGE_FAILED'},{release:true,allowStopped:true});
    });
   }catch{diagnose();}
  }
 }
 function enqueue(id,projectId,local){
  if(!autoRun||stopped||pending.has(id))return;
  // Historical ACK replay never resumes anything: only current queued/fenced
  // local-recovery states are admitted, and startup never calls enqueue.
  const target=task(projectId,id);if(target.row.state!==(local?'persisting':'queued'))return;
  const entry={id,projectId,local};pending.set(id,entry);queue.push(entry);queueMicrotask(pump);
 }
 function pump(){
  if(running||stopped||signal.aborted)return;const entry=queue.shift();if(!entry)return;running=true;
  const promise=execute(entry).finally(()=>{active.delete(promise);pending.delete(entry.id);running=false;pump();});active.add(promise);
 }
 function reconcile(){
  if(reconciled||!ownsStoreLock(store)||!schemaPresent())return;reconciled=true;
  const rows=db.prepare("SELECT id,projectId FROM image_tasks WHERE state IN ('queued','dispatching','receiving','persisting') ORDER BY id LIMIT ?").all(IMAGE_LIMITS.queuedGlobal+1);
  if(rows.length>IMAGE_LIMITS.queuedGlobal){diagnose();return;}
  for(const row of rows){try{const target=task(row.projectId,row.id);reviewBinding(target);let receipt=target.receipt;try{receipt??=storage.readReceipt(stageTask(target));}catch{}
   tx(()=>{if(!target.dto.dispatched)change(target,{state:'interrupted_before_dispatch',errorCode:'IMAGE_INTERRUPTED'});
    else if(receipt)change(target,{state:'local_result_error',stagedReceipt:target.row.stagedReceipt??canonical(receipt),errorCode:'IMAGE_LOCAL_RECOVERY_REQUIRED'});
    else change(target,{state:'outcome_unknown',errorCode:'IMAGE_OUTCOME_UNKNOWN'});});
  }catch{diagnose();}}
 }
 const profiles={items:[{providerId:'mock',model:IMAGE_MODELS.mock,name:'Mock 本地图像流程测试',enabled:true,isMock:true,evidence:'deterministic-mock',options:IMAGE_FIXED_OPTIONS},{providerId:'openai',model:IMAGE_MODELS.openai,name:'OpenAI Images · 未启用',enabled:false,isMock:false,evidence:'offline-tested-not-live',options:IMAGE_FIXED_OPTIONS}],liveEnabled:false};
 function listProfiles(input={}){
  const value=structuredClone(profiles);
  // Opt-in metadata only, taken from the same safe snapshot as the profile.
  // A revision is neither readiness nor approval; default DTO bytes stay intact.
  const withRevision=(profile,state)=>{if(input.includeSettingsRevision===true){const revision=state?.revision;if(Number.isSafeInteger(revision)&&revision>0)profile.settingsRevision=revision;}return profile;};
  try{const state=settings?.[IMAGE_SETTINGS_READ_CURRENT]();value.liveEnabled=Boolean(live&&state?.configuration.enabled&&state?.secret.configured);value.items[1].enabled=value.liveEnabled;value.items[1].name=value.liveEnabled?'OpenAI Images · 需逐次确认':'OpenAI Images · 未启用';withRevision(value.items[1],state);}catch{}
  try{const state=customSettings?.[IMAGE_SETTINGS_READ_CURRENT]();if(isCompleteCustomImageConfiguration(state?.configuration)){const enabled=Boolean(compatible&&state.configuration.enabled&&state.secret.configured);value.items.push(withRevision({providerId:'openai-compatible',model:state.configuration.model,name:enabled?'自定义 Images · 需逐次确认':'自定义 Images · 未启用',enabled,isMock:false,evidence:'offline-tested-not-live',options:state.configuration.options},state));value.liveEnabled||=enabled;}}catch{}
  try{const state=comfySettings?.[COMFY_SETTINGS_READ_CURRENT]();if(isCompleteComfyImageConfiguration(state?.configuration)){const enabled=Boolean(comfyConnector&&state.configuration.enabled&&state.readiness.checked);value.items.push(withRevision({providerId:'comfy-local',model:state.configuration.model,name:enabled?'ComfyUI 本机 · 逐次确认':'ComfyUI 本机 · 尚未检查',enabled,isMock:false,evidence:'offline-tested-not-live',options:state.configuration.options},state));value.liveEnabled||=enabled;}}catch{}
  return value;
 }
 const handlers={...reviews.handlers,...remote.handlers,'image.profile.list':listProfiles,...history.handlers,...Object.fromEntries(IMAGE_MUTATION_OPERATIONS.map(operation=>[operation,input=>mutateWithSource(operation,input)]))};
 async function drain(){if(!stopped){stopped=true;controller.abort();reviews.stop();queue.length=0;}await Promise.all([boundedShutdown(Promise.allSettled([...active]),'IMAGE_STOP_TIMEOUT'),remote.drain()]);}
 for(const operation of Object.keys(handlers)){if(Object.hasOwn(history.handlers,operation))continue;const handler=handlers[operation];handlers[operation]=input=>{if(!schemaPresent())fail('IMAGE_SCHEMA_REQUIRED',503);return handler(input);};}
 const service={handlers,drain,approveReviewed:approval=>{const input=reviews.readForApproval(approval);return mutateWithSource('image.generate',input,approval);},rejectReview:reviews.reject};owners.set(db,{root:store.root,signal:ownerSignal,generate,autoRun,fault,settings,liveGateway,customSettings,customGateway,comfySettings,comfyConnector,service});reconcile();remote.reconcile();return service;
}
