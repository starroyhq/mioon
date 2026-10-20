import {bindAgentTaskJobInside,assertAgentTaskJobEffect,withAgentTaskJobOrigin,recordAgentTaskJobDispatch,isAgentTaskEffectBlocked,setAgentTaskJobResumer,setAgentTaskJobStopper,agentTaskJobBinding,isAgentTaskJobStopped} from './agent/task-effects-v2.ts';
import {createComfyAdmission,COMFY_MODULE_UNAVAILABLE_MESSAGE} from './comfy/admission.ts';
import {getWorkspaceRestoreContext} from './workspace-restore-schema.ts';
import {workspaceRestoreError} from './workspace-restore-policy.ts';
import {randomUUID,createHash} from 'node:crypto';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {IMAGE_LIMITS,IMAGE_MODELS,IMAGE_FIXED_OPTIONS,IMAGE_MUTATION_OPERATIONS,IMAGE_UNRESOLVED_STATES,isImageMutationResponse} from '@mioon/contracts';
import {createImageHistoryReaders,imageServiceMessages as messages,imageServiceError as error} from './images/history.ts';
import type {ImageHistoryReaders,ImageHistoryTask,ImageGroupView,ImageTaskView,ImageGenerationView} from './images/history.ts';
import {createOwnedMediaGraphReader} from './inspection.ts';
import {createImageEditSourceResolver,imageEditFields} from './images/edit-source.ts';
import type {ImageEditSourceResolver,VerifiedEditSource} from './images/edit-source.ts';
import {createImageStorage} from './image-storage.ts';
import type {ImageReceipt,ImageStorageTask} from './image-storage.ts';
import {createMockImageAdapter} from './images/adapter.ts';
import type {ImageAdapterResult} from './images/adapter.ts';
import {validatePng} from './images/png.ts';
import {ownsStoreLock} from './db.ts';
import {awaitProvider,boundedShutdown} from './operation-lifecycle.ts';
import {createImageReviewServices} from './images/reviews.ts';
import type {ImageGenerationInput,ImageReviewDto,ImageStore,ExpectedImageSettings} from './images/reviews.ts';
import {createLiveImageGateway,createCompatibleImageGateway} from './images/gateway.ts';
import type {Gateways} from './images/gateway.ts';
import {createImageSettings} from './images/settings.ts';
import {IMAGE_SETTINGS_ASSERT_CURRENT,IMAGE_SETTINGS_READ_CURRENT} from './images/settings.ts';
import {DEFAULT_IMAGE_CONFIGURATION,isCompleteCustomImageConfiguration,getCustomImageDestination} from '../../contracts/src/image-settings.ts';
import {createComfyRemoteServices} from './comfy/remote.ts';
import type {ComfyObserveCandidate,ComfyRemoteConnector,ComfyRemoteTask} from './comfy/remote.ts';
import {createComfyConnector} from './comfy/connector.ts';
import {createComfySettings} from './comfy/settings.ts';
import {COMFY_SETTINGS_ASSERT_CURRENT,COMFY_SETTINGS_READ_CURRENT} from './comfy/settings.ts';
import {isCompleteComfyImageConfiguration,getComfyImageDestination} from '../../contracts/src/comfy-images.ts';
import {IMAGE_REVIEW_DESTINATION} from '../../contracts/src/image-reviews.ts';

type ImageSettingsService=Awaited<ReturnType<typeof createImageSettings>>;
type ComfySettingsService=Awaited<ReturnType<typeof createComfySettings>>;
type ImageReviewService=ReturnType<typeof createImageReviewServices>;
type ComfyConnector=ReturnType<typeof createComfyConnector>;
type ImageMutationInput=ImageGenerationView&{taskId?: string; [key: string]: unknown};
type ImageFault=(stage: string,details?: Record<string, unknown>)=>unknown;
type GenerateImage=(snapshot: unknown,context: {signal?: AbortSignal; beforeDispatch?: unknown; sourceBytes?: unknown; settingsRevision?: unknown; configuration?: unknown})=>Promise<ImageAdapterResult>;
export interface ImageServicesOptions {
 signal?: AbortSignal;
 assertLiveAllowed?: ()=>void;
 generate?: GenerateImage;
 autoRun?: boolean;
 fault?: ImageFault;
 settings?: ImageSettingsService;
 liveGateway?: Gateways|null;
 customSettings?: ImageSettingsService;
 customGateway?: Gateways|null;
 comfySettings?: ComfySettingsService;
 comfyConnector?: ComfyConnector;
 comfyModuleAvailability?: unknown;
}
export interface ImageProfileItem {
 providerId: string;
 model: string;
 name: string;
 enabled: boolean;
 isMock: boolean;
 evidence: string;
 options: Record<string, unknown>;
 settingsRevision?: number;
}
export interface ImageProfileList {
 items: ImageProfileItem[];
 liveEnabled: boolean;
}
export interface ImageService {
 readonly handlers: Readonly<Record<string,(input: unknown,context?: {signal?: AbortSignal|null; [key: string]: unknown})=>unknown>>;
 readonly drain: ()=>Promise<void>;
 readonly approveReviewed: ImageReviewService['readForApproval'] extends (...args: never[])=>unknown?(approval: unknown)=>unknown:never;
 readonly rejectReview: (input: unknown)=>unknown;
}
interface ImageAttempt {readonly id: string; readonly projectId: string; readonly local: boolean;resumeRequested?:boolean}
interface ImageOwnerRecord {
 readonly root: string;
 readonly signal: AbortSignal|undefined;
 readonly generate: GenerateImage;
 readonly autoRun: boolean;
 readonly fault: ImageFault;
 readonly settings?: ImageSettingsService;
 readonly liveGateway?: Gateways|null;
 readonly customSettings?: ImageSettingsService;
 readonly customGateway?: Gateways|null;
 readonly comfySettings?: ComfySettingsService;
 readonly comfyConnector?: ComfyConnector;
 readonly comfyModuleAvailability?: unknown;
 readonly service: ImageService;
}
const owners=new WeakMap<DatabaseSync,ImageOwnerRecord>();
const noop: ImageFault=()=>{};
const canonical=(value: unknown): string=>JSON.stringify(value,(_key: string,v: unknown)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v) as string;
const hash=(value: unknown): string=>createHash('sha256').update(canonical(value)).digest('hex');
const now=(): string=>new Date().toISOString();
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
// Safe custom pre-dispatch diagnostics. A dispatched task always remains unknown.
const customPreDispatchCodes=new Set(['IMAGE_NETWORK_DENIED','IMAGE_CONNECTION_FAILED','IMAGE_TIMEOUT','IMAGE_DISPATCH_BLOCKED','IMAGE_SETTINGS_CONFLICT','IMAGE_SETTINGS_NOT_CONFIGURED','IMAGE_SETTINGS_DISABLED']);
export function safeImageServiceError(cause: unknown): {code: string; message: string; status: number} {
 if(property(cause,'code')==='COMFY_MODULE_UNAVAILABLE')return {code:'COMFY_MODULE_UNAVAILABLE',message:COMFY_MODULE_UNAVAILABLE_MESSAGE,status:503};
 const rawCode=property(cause,'code');
 const code=typeof rawCode==='string'&&Object.hasOwn(messages,rawCode)?rawCode:'IMAGE_STORAGE_FAILED';
 const rawStatus=property(cause,'status');
 return {code,message:messages[code]??'图像操作未完成，请查看原任务。',status:typeof rawStatus==='number'&&Number.isInteger(rawStatus)&&rawStatus>=400&&rawStatus<=599?rawStatus:503};
}
function fail(code: string,status?: number): never {throw error(code,status);}
function invalid(): never {return fail('IMAGE_RECORD_INVALID');}
const maxRevision=(revision: unknown): void=>{if(!Number.isSafeInteger(revision)||(revision as number)>=Number.MAX_SAFE_INTEGER)fail('IMAGE_CAPACITY',507);};
const bounded=(name: string,size: number|string,nullable=false): string=>`CASE WHEN ${nullable?`${name} IS NULL OR `:''}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${size}) THEN ${name} ELSE 0 END AS ${name}`;
const defaultGenerate: GenerateImage=createMockImageAdapter().generate as unknown as GenerateImage;
const asReceipt=(value: unknown): ImageReceipt|null=>value?value as ImageReceipt:null;

/** Image-specific durable lifecycle. No chat/tool authority and no generic
 * operation dispatch. Live images require dedicated settings and immutable
 * user approval; injected dependencies are trusted tests, never RPC options. */
export function createImageServices(store: ImageStore,{signal:ownerSignal,generate=defaultGenerate,autoRun=true,fault=noop,settings,liveGateway,customSettings,customGateway,comfySettings,comfyConnector,comfyModuleAvailability,assertLiveAllowed}: ImageServicesOptions={}): ImageService {
 if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();
 const old=owners.get(store.db);
 if(old){if(old.root!==store.root||old.signal!==ownerSignal||old.generate!==generate||old.autoRun!==autoRun||old.fault!==fault||old.settings!==settings||old.liveGateway!==liveGateway||old.customSettings!==customSettings||old.customGateway!==customGateway||old.comfySettings!==comfySettings||old.comfyConnector!==comfyConnector||old.comfyModuleAvailability!==comfyModuleAvailability)fail('IMAGE_SERVICE_ACTIVE');return old.service;}
 const {db,tx}=store,queue: ImageAttempt[]=[],pending=new Map<string,ImageAttempt>(),active=new Set<Promise<unknown>>();
 const controller=new AbortController(),signal: AbortSignal=ownerSignal?AbortSignal.any([ownerSignal,controller.signal]):controller.signal;
 let stopped=false,running=false,reconciled=false,reported=false;
 const comfyAdmission=createComfyAdmission(comfyConnector,comfyModuleAvailability);
 const selectedSettings=(providerId: string): ImageSettingsService|ComfySettingsService|null=>providerId==='openai'?settings??null:providerId==='openai-compatible'?customSettings??null:providerId==='comfy-local'?comfySettings??null:null;
 const expectedSettings=(revision: unknown,configuration: unknown): {expectedRevision: number; configuration: unknown}=>({expectedRevision:revision as number,configuration:configuration??{...DEFAULT_IMAGE_CONFIGURATION,enabled:true}});
 const readComfyCurrent=()=>comfySettings?.[COMFY_SETTINGS_READ_CURRENT]()??null;
 const readImageCurrent=(engine: ImageSettingsService|undefined)=>engine?.[IMAGE_SETTINGS_READ_CURRENT]()??null;
 const assertCurrentSettings=(providerId: string,expected: {expectedRevision: number; configuration: unknown})=>{
  if(providerId==='comfy-local'){if(!comfySettings)fail('IMAGE_LIVE_DISABLED',403);return comfySettings[COMFY_SETTINGS_ASSERT_CURRENT](expected);}
  const engine=selectedSettings(providerId);if(!engine)fail('IMAGE_LIVE_DISABLED',403);return (engine as ImageSettingsService)[IMAGE_SETTINGS_ASSERT_CURRENT](expected);
 };
 const reviews=createImageReviewServices(store,{signal,fault,
  getSettings:(providerId: string)=>{assertLiveAllowed?.();if(providerId==='comfy-local'){comfyAdmission.assertAvailable();const current=readComfyCurrent();if(!current)return {revision:0,enabled:false,destination:null};return {revision:current.revision,enabled:Boolean(current.configuration.enabled&&current.readiness?.checked),destination:isCompleteComfyImageConfiguration(current.configuration)?getComfyImageDestination(current.configuration.baseUrl):null,configuration:current.configuration};}const current=readImageCurrent(selectedSettings(providerId) as ImageSettingsService|undefined);if(!current)return {revision:0,enabled:false,destination:providerId==='openai'?IMAGE_REVIEW_DESTINATION:null};return {revision:current.revision,enabled:Boolean(current.configuration.enabled),destination:providerId==='openai'?IMAGE_REVIEW_DESTINATION:isCompleteCustomImageConfiguration(current.configuration)?getCustomImageDestination(current.configuration.baseUrl):null,...(providerId==='openai-compatible'?{configuration:current.configuration}:{})};},
  assertSettings:({revision,configuration},providerId)=>{assertLiveAllowed?.();return assertCurrentSettings(providerId,expectedSettings(revision,configuration));}});
 const live=liveGateway??(settings?createLiveImageGateway({settings}):null);
 const compatible=customGateway??(customSettings?createCompatibleImageGateway({settings:customSettings}):null);
 const selectedGateway=(providerId: string): Gateways|ComfyConnector|null=>providerId==='openai'?live:providerId==='openai-compatible'?compatible:providerId==='comfy-local'?comfyConnector??null:null;
 const selectedApiGateway=(providerId: string): Gateways|null=>providerId==='openai'?live:providerId==='openai-compatible'?compatible:null;
 const history=createImageHistoryReaders(store),{schemaPresent,project,reader,task,group,reviewBinding,prior}=history;
 const storage=createImageStorage(store,{validatePng}),editSources=createImageEditSourceResolver(store,{signal});
 const toInput=(value: ImageGenerationView): ImageGenerationInput=>value as unknown as ImageGenerationInput;
 function owner(): void {if(stopped||signal.aborted)fail('IMAGE_SERVICE_STOPPED',503);if(!ownsStoreLock(store))fail('IMAGE_OWNER_REQUIRED',403);}
 function current(original: ImageHistoryTask,{allowStopped=false}: {allowStopped?: boolean}={}): ImageHistoryTask {
  if(!allowStopped)owner();else if(!ownsStoreLock(store))fail('IMAGE_OWNER_REQUIRED',403);
  const value=task(original.row.projectId,original.row.id,{shallow:true});
  if(value.row.revision!==original.row.revision||value.row.state!==original.row.state||value.row.inputHash!==original.row.inputHash||value.row.input!==original.row.input||value.row.snapshot!==original.row.snapshot)fail('IMAGE_REVISION_CONFLICT');
  return value;
 }
 function change(original: ImageHistoryTask,patch: Record<string, unknown>,{release=false,headVersionId,allowStopped=false}: {release?: boolean; headVersionId?: string|null; allowStopped?: boolean}={}): ImageHistoryTask {
  const value=current(original,{allowStopped});maxRevision(value.row.revision);
  const allowed=['state','dispatched','stagedReceipt','versionId','errorCode'];if(Object.keys(patch).some(key=>!allowed.includes(key)))throw Error('Invalid internal image patch');
  const entries=Object.entries(patch),timestamp=now();
  const result=db.prepare(`UPDATE image_tasks SET ${entries.map(([key])=>`${key}=?`).join(',')},revision=revision+1,updatedAt=? WHERE id=? AND projectId=? AND revision=?`).run(...entries.map(([,v])=>v) as SQLInputValue[],timestamp,value.row.id,value.row.projectId,value.row.revision);
  if(result.changes!==1)fail('IMAGE_REVISION_CONFLICT');
  if(release){const g=reader(value.row.projectId).group(value.row.groupId);maxRevision(g.revision);if(g.activeTaskId!==value.row.id)invalid();db.prepare('UPDATE image_groups SET activeTaskId=NULL,headVersionId=?,revision=revision+1,updatedAt=? WHERE id=? AND projectId=? AND revision=?').run(headVersionId??g.headVersionId,timestamp,g.id,g.projectId,g.revision);}
  return task(value.row.projectId,value.row.id,{shallow:true});
 }
 const count=(table: string,where: string,args: readonly SQLInputValue[],cap: number): number=>{
  const value=db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${table}${where?' WHERE '+where:''} LIMIT ?)`).get(...args,cap+1)?.n;
  return typeof value==='number'?value:0;
 };
 function capacity(projectId: string,generating: boolean): void {
  if(count('image_requests','',[],IMAGE_LIMITS.requestsGlobal)>=IMAGE_LIMITS.requestsGlobal||count('image_requests','projectId=?',[projectId],IMAGE_LIMITS.requestsPerProject)>=IMAGE_LIMITS.requestsPerProject)fail('IMAGE_CAPACITY',507);
  if(!generating)return;
  if(count('image_tasks','',[],IMAGE_LIMITS.tasksGlobal)>=IMAGE_LIMITS.tasksGlobal||count('image_tasks','projectId=?',[projectId],IMAGE_LIMITS.tasksPerProject)>=IMAGE_LIMITS.tasksPerProject)fail('IMAGE_CAPACITY',507);
  const work="state IN ('queued','dispatching','receiving','persisting')";
  if(count('image_tasks',work,[],IMAGE_LIMITS.queuedGlobal)>=IMAGE_LIMITS.queuedGlobal||count('image_tasks',work+' AND projectId=?',[projectId],IMAGE_LIMITS.queuedPerProject)>=IMAGE_LIMITS.queuedPerProject)fail('IMAGE_QUEUE_FULL');
 }
 function accept(operation: string,input: ImageMutationInput,approval?: unknown,verified?: VerifiedEditSource|null): {response: ImageTaskView; replayed: boolean} {
  owner();const projectId=input.projectId as string;project(projectId);const original=prior(operation,input);if(original){if(approval)reviews.verifyReplay(toInput(input),original.id,approval);return {response:original,replayed:true};}
  if(verified)editSources.assertOwned(operation==='image.generate'?toInput(input):toInput(task(projectId,input.taskId as string,{shallow:true}).input),verified.descriptor);
  capacity(projectId,operation==='image.generate');
  let value: ImageTaskView;
  if(operation==='image.generate'){
   const generation=toInput(input);
   if(generation.providerId==='comfy-local')comfyAdmission.assertAvailable();
   if(generation.providerId!=='mock'){if(!selectedSettings(generation.providerId)||!selectedGateway(generation.providerId))fail('IMAGE_LIVE_DISABLED',403);if(!approval){if(generation.providerId==='comfy-local'){const configured=readComfyCurrent();if(!configured||!configured.configuration.enabled||!configured.readiness?.checked)fail('IMAGE_LIVE_DISABLED',403);}else{const configured=readImageCurrent(selectedSettings(generation.providerId) as ImageSettingsService|undefined);if(!configured||!configured.configuration.enabled||!configured.secret?.configured)fail('IMAGE_LIVE_DISABLED',403);}fail('IMAGE_REVIEW_REQUIRED',403);}}
   const id=randomUUID(),timestamp=now();let groupId: string;
   if(generation.groupId){const g=group(generation.projectId,generation.groupId);if(g.revision!==generation.expectedRevision)fail('IMAGE_REVISION_CONFLICT');if(g.activeTaskId!==null)fail('IMAGE_GROUP_BUSY');if(g.name!==generation.name)fail('IMAGE_STATE_CONFLICT');maxRevision(g.revision);groupId=g.id;db.prepare('UPDATE image_groups SET activeTaskId=?,revision=revision+1,updatedAt=? WHERE id=? AND projectId=? AND revision=?').run(id,timestamp,g.id,g.projectId,g.revision);}
   else{groupId=randomUUID();db.prepare('INSERT INTO image_groups(id,projectId,name,revision,headVersionId,activeTaskId,createdAt,updatedAt) VALUES(?,?,?,1,NULL,?,?,?)').run(groupId,generation.projectId,generation.name,id,timestamp,timestamp);}
   const snapshot={schemaVersion:1,projectId:generation.projectId,groupId,taskId:id,name:generation.name,prompt:generation.prompt,providerId:generation.providerId,model:generation.model,options:generation.options,...(input.purpose==='edit'?{purpose:'edit',inputImage:input.inputImage,sourceImage:verified?.descriptor}:{})};
   db.prepare("INSERT INTO image_tasks(id,projectId,groupId,requestId,inputHash,input,snapshot,state,revision,dispatched,stagedReceipt,versionId,errorCode,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,'queued',1,0,NULL,NULL,NULL,?,?)").run(id,generation.projectId,groupId,generation.requestId,hash(generation),canonical(generation),canonical(snapshot),timestamp,timestamp);
   bindAgentTaskJobInside(db,'image',id);
   if(generation.providerId!=='mock')reviews.authorizeAcceptance(generation,id,approval,verified??undefined);
   if(generation.providerId==='comfy-local')remote.prepareTask(generation.projectId,id);
   value=task(generation.projectId,id).dto;
  }else{
   const target=task(projectId,input.taskId as string,{shallow:operation==='image.task.cancelQueued'});reviewBinding(target);if(target.row.revision!==input.expectedRevision)fail('IMAGE_REVISION_CONFLICT');
   if(operation==='image.task.cancelQueued'){
    if(!['queued','interrupted_before_dispatch'].includes(target.row.state)||target.dto.dispatched)fail('IMAGE_STATE_CONFLICT');
    value=change(target,{state:'cancelled_before_dispatch',errorCode:null},{release:true}).dto;
   }else{
    if(!['local_result_error','outcome_unknown'].includes(target.row.state))fail('IMAGE_STATE_CONFLICT');
    const receipt=asReceipt(target.receipt)??storage.readReceipt(stageTask(target));if(!receipt)fail('IMAGE_RESULT_INVALID');
    value=change(target,{state:'persisting',stagedReceipt:target.row.stagedReceipt??canonical(receipt),errorCode:null}).dto;
   }
  }
  if(!isImageMutationResponse(operation,toInput(input),value))invalid();fault('before_request_receipt',{operation,input});
  db.prepare('INSERT INTO image_requests(requestId,operation,projectId,inputHash,canonicalInput,response) VALUES(?,?,?,?,?,?)').run(input.requestId as string,operation,input.projectId as string,hash(input),canonical(input),JSON.stringify(value));
  return {response:value,replayed:false};
 }
 // Async edit preflights cannot prove durable nonacceptance from a missing row.
 // Keep their original key; only the existing synchronous legacy refusal path
 // emits operation-bound absence evidence.
 const proofCodes=new Set(['IMAGE_LIVE_DISABLED','IMAGE_REVIEW_REQUIRED','IMAGE_CAPACITY','IMAGE_QUEUE_FULL','IMAGE_GROUP_BUSY','IMAGE_REVISION_CONFLICT','IMAGE_STATE_CONFLICT','IMAGE_RESULT_INVALID']);
 function notAccepted(cause: unknown,operation: string,input: ImageMutationInput): void {
  const code=property(cause,'code');
  if(input.purpose!=='edit'&&typeof code==='string'&&proofCodes.has(code)&&!db.isTransaction){
   try{project(input.projectId as string);if(input.taskId)task(input.projectId as string,input.taskId);if(input.groupId)group(input.projectId as string,input.groupId);if(!db.prepare('SELECT 1 FROM image_requests WHERE requestId=?').get(input.requestId as string)){if(isRecord(cause))cause.details={imageOutcome:{status:'not_accepted',projectId:input.projectId,operation,requestId:input.requestId,inputHash:hash(input)}};}}catch{/* absence evidence remains unknown */}
  }
 }
 function mutate(operation: string,input: ImageMutationInput,approval?: unknown,verified?: VerifiedEditSource|null): unknown {
  if(Buffer.byteLength(canonical(input))>IMAGE_LIMITS.inputBytes)fail('IMAGE_CAPACITY',507);
  let accepted: {response: ImageTaskView; replayed: boolean};
  try{accepted=tx(()=>accept(operation,input,approval,verified));}
  catch(cause){
   if(!verified)notAccepted(cause,operation,input);
   throw cause;
  }
  const value=accepted.response;
  if(!accepted.replayed){fault('after_acceptance',{operation,input,response:value});
   if(operation!=='image.task.cancelQueued')enqueue(value.id,value.projectId,operation==='image.task.recoverResult');}
  return value;
 }
 function mutateWithSource(operation: string,input: ImageMutationInput,approval?: unknown): unknown {
  if(operation==='image.task.cancelQueued'||operation==='image.generate'&&input.purpose!=='edit')return mutate(operation,input,approval);
  owner();project(input.projectId as string);const replay=prior(operation,input);
  if(replay){if(approval)reviews.verifyReplay(toInput(input),replay.id,approval);return replay;}
  const target=operation==='image.generate'?null:task(input.projectId as string,input.taskId as string),generation=target?.input??input;
  if(generation.purpose!=='edit')return mutate(operation,input,approval);
  const expected=target?.snapshot.sourceImage??(approval?reviews.sourceForApproval(approval):undefined);
  return editSources.verify(toInput(generation as ImageGenerationView),expected).then((verified: VerifiedEditSource)=>{editSources.assertCurrent(toInput(generation as ImageGenerationView),verified);return mutate(operation,input,approval,verified);});
 }
 function diagnose(): void {if(!reported){reported=true;console.error('Skipped invalid local image record.');}}
 function stageTask(value: ImageHistoryTask): ImageStorageTask {return {...value.row,snapshot:value.snapshot} as unknown as ImageStorageTask;}
 async function finalize(original: ImageHistoryTask): Promise<void> {
  const target=current(original),receipt=asReceipt(target.receipt);reviewBinding(target);if(!receipt)fail('IMAGE_RESULT_INVALID');
  const source=target.input.purpose==='edit'?await editSources.verify(toInput(target.input),target.snapshot.sourceImage):null;
  const check=(): ImageHistoryTask=>{const latest=current(target);if(source)editSources.assertCurrent(toInput(latest.input),source);return latest;};
  const file=await storage.publish(stageTask(target),receipt,check);check();fault('after_media_publication',{taskId:target.row.id});
  check();
  const result=tx(()=>{
   const latest=current(target);if(source)editSources.assertOwned(toInput(latest.input),source.descriptor);const g=group(latest.row.projectId,latest.row.groupId);if(g.activeTaskId!==latest.row.id)invalid();
   const maximum=Number(db.prepare('SELECT max(number) AS n FROM image_versions WHERE groupId=?').get(g.id)?.n??0);maxRevision(maximum);const timestamp=now();
   const asset={id:receipt.assetId,projectId:g.projectId,name:`${g.name} · 图像 ${maximum+1}.png`,mimeType:'image/png',sha256:receipt.sha256,width:receipt.width,height:receipt.height,sizeBytes:receipt.byteLength,relativePath:file.relativePath,url:`/media/${receipt.assetId}`,provenance:receipt.isMock?'synthetic-mock':'generated',createdAt:timestamp};
   const version={id:receipt.versionId,projectId:g.projectId,groupId:g.id,taskId:latest.row.id,number:maximum+1,assetId:asset.id,sha256:receipt.sha256,mimeType:'image/png',width:receipt.width,height:receipt.height,byteLength:receipt.byteLength,isMock:receipt.isMock,providerId:latest.snapshot.providerId,model:latest.snapshot.model,options:latest.snapshot.options,...imageEditFields(latest.snapshot),createdAt:timestamp};
   db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(asset.id,asset.projectId,JSON.stringify(asset));
   db.prepare('INSERT INTO image_versions(id,projectId,groupId,taskId,number,assetId,data) VALUES(?,?,?,?,?,?,?)').run(version.id,g.projectId,g.id,latest.row.id,version.number,asset.id,JSON.stringify(version));
   const completed=change(latest,{state:'succeeded',versionId:version.id,errorCode:null},{release:true,headVersionId:version.id});
   (createOwnedMediaGraphReader(db,g.projectId) as unknown as {asset(id: string): unknown}).asset(asset.id);fault('before_result_commit',{taskId:latest.row.id});return completed;
  });
  try{storage.discardStagedPng(stageTask(result),()=>{current(result);});}catch{/* A retained private stage is safe; never undo a committed result. */}
 }
 const remote=createComfyRemoteServices(store,{signal,owner,readTask:(projectId: string,taskId: string)=>task(projectId,taskId) as unknown as ComfyRemoteTask,readReview:(projectId: string,taskId: string)=>reviews.getForTask(projectId,taskId),connector:comfyConnector as unknown as ComfyRemoteConnector,admission:comfyAdmission,fault,
  failTask:(target: ComfyRemoteTask)=>change(target as unknown as ImageHistoryTask,{state:'failed',errorCode:'COMFY_EXECUTION_FAILED'},{release:true}),
  stageResult:async(target: ComfyRemoteTask,candidate: ComfyObserveCandidate,claim: ()=>unknown)=>{
   let original=current(target as unknown as ImageHistoryTask);const check=(): ImageHistoryTask=>{claim();return current(original);};
   try{check();const receipt=await storage.stage(stageTask(original),candidate,check);fault('after_result_manifest',{taskId:original.row.id});
    original=tx(()=>{check();return change(original,{state:'persisting',stagedReceipt:canonical(receipt),errorCode:null});});fault('after_result_receipt',{taskId:original.row.id});await finalize(original);
   }catch(cause){try{const checked=current(original,{allowStopped:true});claim();let receipt=asReceipt(checked.receipt);try{receipt??=storage.readReceipt(stageTask(checked));}catch{}tx(()=>{claim();if(receipt)change(checked,{state:'local_result_error',stagedReceipt:checked.row.stagedReceipt??canonical(receipt),errorCode:'IMAGE_RESULT_INVALID'},{allowStopped:true});else if(checked.row.state!=='outcome_unknown')change(checked,{state:'outcome_unknown',errorCode:'IMAGE_OUTCOME_UNKNOWN'},{allowStopped:true});});}catch{}throw cause;}
  }});
 function execute(entry:ImageAttempt):Promise<void>{return withAgentTaskJobOrigin(db,'image',entry.id,()=>executeInside(entry));}
 async function executeInside(entry: ImageAttempt): Promise<void> {
  let original: ImageHistoryTask|undefined,blockedGate=false;
  const effectGate=():void=>{try{assertAgentTaskJobEffect(db,'image',entry.id);}catch(error){if(isAgentTaskEffectBlocked(error))blockedGate=true;throw error;}};
  try{
   owner();original=task(entry.projectId,entry.id,{shallow:true});reviewBinding(original);
   if(entry.local){if(original.row.state!=='persisting')return;await finalize(original);return;}
   if(original.row.state!=='queued')return;
   effectGate();
   const projection={providerId:original.snapshot.providerId,model:original.snapshot.model,prompt:original.snapshot.prompt,options:original.snapshot.options,...imageEditFields(original.snapshot)};
   const liveReview=projection.providerId!=='mock'?reviews.getForTask(entry.projectId,entry.id):null;
   const gateway=selectedGateway(projection.providerId);
   if(liveReview&&!gateway)fail('IMAGE_LIVE_DISABLED',403);
   const apiGateway=selectedApiGateway(projection.providerId);
   const source=original.input.purpose==='edit'?await editSources.verify(toInput(original.input) as ImageGenerationInput,original.snapshot.sourceImage):null;
   const dispatch=(): void=>{effectGate();if(liveReview)assertLiveAllowed?.();if(source)editSources.assertCurrent(toInput((original as ImageHistoryTask).input) as ImageGenerationInput,source);original=tx(()=>{effectGate();if(liveReview)assertLiveAllowed?.();const frozen=original as ImageHistoryTask;current(frozen);if(source)editSources.assertOwned(toInput(frozen.input) as ImageGenerationInput,source.descriptor);if(liveReview){reviews.beforeDispatch(toInput(frozen.input) as ImageGenerationInput,frozen.row.id);recordAgentTaskJobDispatch(db,'image',entry.id);}const changed=change(frozen,{state:'dispatching',dispatched:1,errorCode:null});if(projection.providerId==='comfy-local')remote.beforeSubmit(entry.projectId,entry.id);return changed;});fault('after_dispatch_fence',{taskId:(original as ImageHistoryTask).row.id});};
   if(projection.providerId==='comfy-local'){
    if(!liveReview||!('execution' in liveReview)||!('configuration' in liveReview))fail('IMAGE_REVIEW_REQUIRED',403);
    await awaitProvider(()=>comfyConnector!.submit({execution:liveReview.execution,config:liveReview.configuration,signal,beforeSubmit:dispatch}),signal,{submit:true});
    current(original);tx(()=>{remote.submitted(entry.projectId,entry.id);original=change(original as ImageHistoryTask,{state:'receiving',errorCode:null});});return;
   }
   const result=await awaitProvider(()=>liveReview&&apiGateway?apiGateway.generate(projection,{signal,beforeDispatch:dispatch,...(source?{sourceBytes:source.bytes}:{}),settingsRevision:liveReview.settingsRevision,...(projection.providerId==='openai-compatible'&&'configuration' in liveReview?{configuration:liveReview.configuration}:{})}):generate(projection,{signal,beforeDispatch:dispatch,...(source?{sourceBytes:source.bytes}:{})}),signal,{submit:true});
   const dispatchedState=current(original);if(dispatchedState.row.state!=='dispatching'||!dispatchedState.dto.dispatched)invalid();
   const receipt=await storage.stage(stageTask(original),result,()=>{current(original as ImageHistoryTask);});fault('after_result_manifest',{taskId:original.row.id});
   original=tx(()=>change(original as ImageHistoryTask,{state:'persisting',stagedReceipt:canonical(receipt),errorCode:null}));fault('after_result_receipt',{taskId:original.row.id});
   await finalize(original);
  }catch(cause){
   if(!original)return;
   try{
    // A failed ownership/revision fence never authorizes another row write.
    const checked=current(original,{allowStopped:true});reviewBinding(checked);
    if(!checked.dto.dispatched&&(blockedGate||isAgentTaskEffectBlocked(cause))){if(isAgentTaskJobStopped(db,'image',entry.id))tx(()=>change(checked,{state:'cancelled_before_dispatch',errorCode:null},{release:true,allowStopped:true}));return;}
    let receipt=asReceipt(checked.receipt);try{receipt??=storage.readReceipt(stageTask(checked));}catch{}
    tx(()=>{
     if(checked.input.providerId==='comfy-local'&&checked.dto.dispatched)remote.submissionUnknown(checked.row.projectId,checked.row.id);
     if(receipt)change(checked,{state:'local_result_error',stagedReceipt:checked.row.stagedReceipt??canonical(receipt),errorCode:'IMAGE_RESULT_INVALID'},{allowStopped:true});
     else if(checked.dto.dispatched)change(checked,{state:'outcome_unknown',errorCode:'IMAGE_OUTCOME_UNKNOWN'},{allowStopped:true});
     else if(stopped||signal.aborted)change(checked,{state:'interrupted_before_dispatch',errorCode:'IMAGE_INTERRUPTED'},{allowStopped:true});
     else{const code=property(cause,'code');change(checked,{state:'failed',errorCode:typeof code==='string'&&messages[code]?code:checked.snapshot.providerId==='openai-compatible'&&typeof code==='string'&&customPreDispatchCodes.has(code)?code:'IMAGE_STORAGE_FAILED'},{release:true,allowStopped:true});}
    });
   }catch{diagnose();}
  }
 }
 function enqueue(id: string,projectId: string,local: boolean): void {
  if(!autoRun||stopped||pending.has(id))return;
  // Historical ACK replay never resumes anything: only current queued/fenced
  // local-recovery states are admitted, and startup never calls enqueue.
  const target=task(projectId,id);if(target.row.state!==(local?'persisting':'queued'))return;
  const entry: ImageAttempt={id,projectId,local};pending.set(id,entry);queue.push(entry);queueMicrotask(pump);
 }
 function pump(): void {
  if(running||stopped||signal.aborted)return;const entry=queue.shift();if(!entry)return;running=true;
  const promise=execute(entry).finally(()=>{active.delete(promise);pending.delete(entry.id);running=false;if(entry.resumeRequested)enqueue(entry.id,entry.projectId,false);pump();});active.add(promise);
 }
 function reconcile(): void {
  if(reconciled||!ownsStoreLock(store)||!schemaPresent())return;reconciled=true;
  const rows=db.prepare("SELECT id,projectId FROM image_tasks WHERE state IN ('queued','dispatching','receiving','persisting') ORDER BY id LIMIT ?").all(IMAGE_LIMITS.queuedGlobal+1);
  if(rows.length>IMAGE_LIMITS.queuedGlobal){diagnose();return;}
  for(const row of rows){try{const projectId=String(row.projectId),taskId=String(row.id);const target=task(projectId,taskId);reviewBinding(target);let receipt=asReceipt(target.receipt);try{receipt??=storage.readReceipt(stageTask(target));}catch{}
   if(target.row.state==='queued'&&!target.dto.dispatched&&agentTaskJobBinding(db,'image',taskId))continue;
   tx(()=>{if(!target.dto.dispatched)change(target,{state:'interrupted_before_dispatch',errorCode:'IMAGE_INTERRUPTED'});
    else if(receipt)change(target,{state:'local_result_error',stagedReceipt:target.row.stagedReceipt??canonical(receipt),errorCode:'IMAGE_LOCAL_RECOVERY_REQUIRED'});
    else change(target,{state:'outcome_unknown',errorCode:'IMAGE_OUTCOME_UNKNOWN'});});
  }catch{diagnose();}}
 }
 const profiles: ImageProfileList={items:[{providerId:'mock',model:IMAGE_MODELS.mock,name:'Mock 本地图像流程测试',enabled:true,isMock:true,evidence:'deterministic-mock',options:{...IMAGE_FIXED_OPTIONS}},{providerId:'openai',model:IMAGE_MODELS.openai,name:'OpenAI Images · 未启用',enabled:false,isMock:false,evidence:'offline-tested-not-live',options:{...IMAGE_FIXED_OPTIONS}}],liveEnabled:false};
 function listProfiles(input: {includeSettingsRevision?: boolean}={}): ImageProfileList {
  const value=structuredClone(profiles);
  const withRevision=(profile: ImageProfileItem,state: {revision?: unknown}|undefined): ImageProfileItem=>{if(input.includeSettingsRevision===true){const revision=state?.revision;if(Number.isSafeInteger(revision)&&(revision as number)>0)profile.settingsRevision=revision as number;}return profile;};
  try{const state=settings?.[IMAGE_SETTINGS_READ_CURRENT]();value.liveEnabled=Boolean(live&&state?.configuration.enabled&&state?.secret.configured);const liveItem=value.items[1];if(liveItem){liveItem.enabled=value.liveEnabled;liveItem.name=value.liveEnabled?'OpenAI Images · 需逐次确认':'OpenAI Images · 未启用';withRevision(liveItem,state);}}catch{/* settings absence is not readiness */}
  try{const state=customSettings?.[IMAGE_SETTINGS_READ_CURRENT]();if(state&&isCompleteCustomImageConfiguration(state.configuration)){const enabled=Boolean(compatible&&state.configuration.enabled&&state.secret.configured);value.items.push(withRevision({providerId:'openai-compatible',model:state.configuration.model,name:enabled?'自定义 Images · 需逐次确认':'自定义 Images · 未启用',enabled,isMock:false,evidence:'offline-tested-not-live',options:state.configuration.options},state));value.liveEnabled||=enabled;}}catch{/* settings absence is not readiness */}
  try{const state=comfySettings?.[COMFY_SETTINGS_READ_CURRENT]();if(state&&isCompleteComfyImageConfiguration(state.configuration)){const enabled=Boolean(comfyConnector&&state.configuration.enabled&&state.readiness.checked);value.items.push(withRevision({providerId:'comfy-local',model:state.configuration.model,name:enabled?'ComfyUI 本机 · 逐次确认':'ComfyUI 本机 · 尚未检查',enabled,isMock:false,evidence:'offline-tested-not-live',options:state.configuration.options},state));value.liveEnabled||=enabled;}}catch{/* settings absence is not readiness */}
  return value;
 }
 const handlers: Record<string,(input: unknown,context?: {signal?: AbortSignal|null; [key: string]: unknown})=>unknown>={...reviews.handlers,...remote.handlers,'image.profile.list':(input: unknown)=>listProfiles(isRecord(input)?input:{}) ,...history.handlers,...Object.fromEntries(IMAGE_MUTATION_OPERATIONS.map(operation=>[operation,(input: unknown)=>mutateWithSource(operation,input as unknown as ImageMutationInput)]))};
 const removeResumer=setAgentTaskJobResumer(db,'image',runId=>{for(const row of db.prepare("SELECT t.id,t.projectId FROM image_tasks t JOIN agent_task_job_origins_v2 o ON o.kind='image' AND o.jobId=t.id AND o.projectId=t.projectId WHERE o.runId=? AND t.state='queued' AND t.dispatched=0 ORDER BY t.createdAt,t.id").all(runId)){const entry=pending.get(String(row.id));if(entry)entry.resumeRequested=true;else enqueue(String(row.id),String(row.projectId),false);}});
 const removeStopper=setAgentTaskJobStopper(db,'image',(runId,stepId)=>{for(const row of db.prepare("SELECT t.id,t.projectId,t.revision FROM image_tasks t JOIN agent_task_job_origins_v2 o ON o.kind='image' AND o.jobId=t.id AND o.projectId=t.projectId WHERE o.runId=? AND (? IS NULL OR o.stepId=?) AND t.state IN ('queued','interrupted_before_dispatch') AND t.dispatched=0 ORDER BY t.id").all(runId,stepId??null,stepId??null))withAgentTaskJobOrigin(db,'image',String(row.id),()=>{
  try{handlers['image.task.cancelQueued']!({projectId:String(row.projectId),taskId:String(row.id),expectedRevision:Number(row.revision),requestId:`agent-stop:${runId}:${String(row.id)}`});}
  catch(error){if(property(error,'code')!=='IMAGE_CAPACITY')throw error;
   // The v2 stop control is already durable. A full legacy request quota must
   // not prevent stopping; keep the domain change and v2 event atomic without
   // inserting a request beyond that frozen quota.
   tx(()=>{const target=task(String(row.projectId),String(row.id),{shallow:true});reviewBinding(target);if(!target.dto.dispatched&&['queued','interrupted_before_dispatch'].includes(target.row.state))change(target,{state:'cancelled_before_dispatch',errorCode:null},{release:true});});
  }
 });});
 async function drain(): Promise<void> {removeResumer();removeStopper();if(!stopped){stopped=true;controller.abort();reviews.stop();queue.length=0;}await Promise.all([boundedShutdown(Promise.allSettled([...active]),'IMAGE_STOP_TIMEOUT'),remote.drain()]);}
 for(const operation of Object.keys(handlers)){if(Object.hasOwn(history.handlers,operation))continue;const handler=handlers[operation];if(!handler)continue;handlers[operation]=(input: unknown)=>{if(!schemaPresent())fail('IMAGE_SCHEMA_REQUIRED',503);return handler(input);};}
 const approveReviewed=(approval: unknown): unknown=>{const input=reviews.readForApproval(approval);return mutateWithSource('image.generate',input as unknown as ImageMutationInput,approval);};
 const service: ImageService={handlers,drain,approveReviewed:approveReviewed as ImageService['approveReviewed'],rejectReview:reviews.reject};
 owners.set(db,{root:store.root,signal:ownerSignal,generate,autoRun,fault,settings,liveGateway,customSettings,customGateway,comfySettings,comfyConnector,comfyModuleAvailability,service});
 reconcile();remote.reconcile();return service;
}
