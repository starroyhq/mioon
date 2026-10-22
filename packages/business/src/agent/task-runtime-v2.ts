import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {deriveAgentEndpoint} from '@mioon/contracts';
import {agentTaskControlSchema,agentTaskDiagnosticSchema,agentTaskLocaleSchema,DEFAULT_AGENT_TASK_LOCALE,DEFAULT_AGENT_TASK_POLICY} from '@mioon/contracts/agent-tasks-v2';
import type {AgentTaskJson,AgentTaskLocale,AgentTaskSnapshot,AgentTaskStep,AgentTaskTarget,AgentTaskRun} from '@mioon/contracts/agent-tasks-v2';
import type {WorkspaceStore} from '../db.ts';
import {createAgentTaskJournal} from './task-journal-v2.ts';
import type {AgentTaskJournal} from './task-journal-v2.ts';
import type {AgentTaskTools,PreparedAgentTaskTool} from './task-tools-v2.ts';
import {setAgentTaskEffectGate,resumeAgentTaskJobs,stopAgentTaskJobs} from './task-effects-v2.ts';
import {AGENT_CREDENTIAL_ACQUIRE,sanitizeAgentCredentialResult,sanitizeAgentSettingsResult} from './settings.ts';
import type {AgentSettingsService} from './settings.ts';
import type {ChatAuthorizations} from './chat-runtime.ts';
import type {AgentConfiguration} from './config.ts';
import {parseAgentConfiguration} from './config.ts';
import {agentChatHttpStatus,safeAgentChatError} from './chat-errors.ts';
import {createTaskGateway,buildTaskModelRequest,taskContinuation,taskResponseLanguageContext,taskResponseLocale,taskToolExplanation,TASK_MODEL_LIMITS,wasTaskSubmissionPrevented} from './task-gateway-v2.ts';
import type {TaskGateway,TaskModelOutput} from './task-gateway-v2.ts';
import {agentTaskDisplayTargetReader,projectAgentTaskChangeDisplay,projectAgentTaskStepDisplay} from './task-display-v2.ts';

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const json=(value:unknown):AgentTaskJson=>JSON.parse(JSON.stringify(value??null)) as AgentTaskJson;
const code=(value:unknown):string=>record(value)&&typeof value.code==='string'?value.code:'AGENT_TASK_FAILED';
const storageError=(value:unknown):boolean=>/^(?:ERR_SQLITE|SQLITE_|AGENT_TASK_STORAGE_)/u.test(code(value));
const terminal=(run:AgentTaskRun):boolean=>['completed','failed','stopped','reverted'].includes(run.status);
const attachmentInstructions:Record<AgentTaskLocale,string>={
  'zh-Hans':'用户为本轮选择的附件（仅可使用这些托管句柄）：',
  'zh-Hant':'使用者為本輪選取的附件（僅可使用這些代管代碼）：',
  en:'Attachments selected by the user for this run (use only these managed handles):',
  ja:'ユーザーがこのラウンドで選択した添付ファイル（これらの管理済みハンドルのみ使用可）：',
};
const skippedInstructions:Record<AgentTaskLocale,string>={
  'zh-Hans':'这一处由用户保留，本轮不要再改。请继续处理其他未跳过的目标。',
  'zh-Hant':'這一處由使用者保留，本輪不要再修改。請繼續處理其他未略過的目標。',
  en:'The user kept this target. Do not modify it again in this run. Continue with other targets that have not been skipped.',
  ja:'この対象はユーザーが保持しました。この実行では再び変更しないでください。スキップしていない他の対象を続けて処理してください。',
};
export function agentTaskFailure(value:string):Error&{code:string;status:number}{
  const messages:Record<string,string>={AGENT_TASK_NOT_FOUND:'任务不存在。',AGENT_TASK_CLOSED:'任务服务已关闭。',AGENT_TASK_READ_ONLY:'恢复副本中的智能助理任务仅供查看。',AGENT_TASK_STOPPED:'任务已停止，尚未发出的工作已阻断。',AGENT_TASK_INVALID:'任务参数无效。',AGENT_TASK_BUSY:'本项目已有未结束任务，请继续或停止原任务。',AGENT_TASK_CONSENT_REQUIRED:'当前目标、模型和项目任务范围尚未授权，或授权已撤销。',AGENT_TASK_SETTINGS_CHANGED:'连接设置已变化，请重新确认目标和模型。',AGENT_TASK_TARGET_CHANGED:'该目标已被手动修改，任务已暂停。',AGENT_TASK_TARGET_CLAIMED:'该目标正在手动编辑，任务已暂停。',AGENT_TASK_UNKNOWN_RESULT:'上一步结果未知，请先核对原请求。',AGENT_TASK_REVISION_CONFLICT:'任务已被其他窗口更新，请重新读取。',AGENT_TASK_REQUEST_CONFLICT:'此请求标识已用于其他内容。',AGENT_TASK_STORAGE_UNAVAILABLE:'无法安全读取或保存任务记录。',AGENT_TASK_FAILED:'任务未完成，请检查已保存记录。',AGENT_TASK_PAUSED:'任务已暂停。',AGENT_TASK_APPROVAL_REQUIRED:'此操作需要确认。'};
  return Object.assign(new Error(messages[value]??messages.AGENT_TASK_FAILED),{code:value,status:value==='AGENT_TASK_NOT_FOUND'?404:value==='AGENT_TASK_INVALID'?400:409});
}
function modelOutput(value:unknown):TaskModelOutput {
  if(!record(value)||typeof value.text!=='string'||!Array.isArray(value.toolCalls)||!Object.hasOwn(value,'providerOutput'))throw agentTaskFailure('AGENT_TASK_STORAGE_UNAVAILABLE');
  return value as unknown as TaskModelOutput;
}
function safeSnapshot(value:AgentTaskSnapshot,store:WorkspaceStore):AgentTaskSnapshot {
  const copy=structuredClone(value),readTarget=agentTaskDisplayTargetReader(store,value.run.projectId);delete copy.run.context;
  const conflict=copy.run.status==='paused'&&['conflict','editing'].includes(copy.run.pauseReason??''),flagged=copy.steps.filter(step=>record(step.data)&&step.data.backgroundInvalidated===true),pending=copy.steps.filter(step=>step.kind==='tool'&&['intent','awaiting_approval'].includes(step.status)).at(-1);
  const skippedSteps=new Set(copy.run.skippedTargets?.map(item=>item.stepId)??[]);
  copy.steps=copy.steps.map(step=>{if(record(step.data)&&step.data.backgroundApprovalRequired===true){step.approvalRequired=true;if(Array.isArray(step.data.dispatchApprovalTargets))step.targets=step.data.dispatchApprovalTargets as unknown as AgentTaskTarget[];}const backgroundConflict=flagged.includes(step);step.display=projectAgentTaskStepDisplay(step,readTarget,skippedSteps.has(step.id)||conflict&&(backgroundConflict||flagged.length===0&&step===pending));if(step.display&&conflict&&backgroundConflict)step.display.conflict=true;delete step.request;delete step.data;if(step.kind==='model'&&record(step.result))step.result={text:typeof step.result.text==='string'?step.result.text:'',toolCalls:json(step.result.toolCalls??[])};return step;});
  copy.changes=copy.changes.map(change=>{change.display=projectAgentTaskChangeDisplay(change);change.before=null;change.after=null;delete change.undo;return change;});return copy;
}
interface Active {controller:AbortController;promise:Promise<void>;restartRequested:boolean}
export interface AgentTaskRuntimeOptions {store:WorkspaceStore;agentSettings:AgentSettingsService;authorizations:ChatAuthorizations;tools?:AgentTaskTools;selfPort:()=>number;gateway?:TaskGateway;journal?:AgentTaskJournal;readOnly?:boolean;assertMutationAllowed?:()=>void}
/** SQLite owns progress. Process-local state is only cancellation and a single
 * current executor; opening this runtime never restarts an interrupted run. */
export function createAgentTaskRuntime({store,agentSettings,authorizations,tools,selfPort,gateway=createTaskGateway(),journal:sourceJournal=createAgentTaskJournal(store),readOnly=false,assertMutationAllowed}:AgentTaskRuntimeOptions){
  const instanceId=randomUUID(),active=new Map<string,Active>();let closed=false,storageFaulted=false;
  // A SQLite failure is an audit failure, including when it occurs in a domain
  // transaction callback. Never turn it into an ordinary failed tool result.
  const journal=new Proxy(sourceJournal,{get(target,property,receiver){const value:unknown=Reflect.get(target,property,receiver);if(typeof value!=='function')return value;return (...args:unknown[]):unknown=>{try{return Reflect.apply(value,target,args);}catch(error){if(storageError(error)){storageFaulted=true;for(const entry of active.values())entry.controller.abort();throw agentTaskFailure('AGENT_TASK_STORAGE_UNAVAILABLE');}throw error;}};}});
  const hasTables=!!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_task_runs_v2'").get();
  if(!readOnly)journal.recover();
  const checkOpen=():void=>{if(closed)throw agentTaskFailure('AGENT_TASK_CLOSED');};
  function mutable():void {checkOpen();if(readOnly)throw agentTaskFailure('AGENT_TASK_READ_ONLY');if(storageFaulted)throw agentTaskFailure('AGENT_TASK_STORAGE_UNAVAILABLE');assertMutationAllowed?.();}
  function toolset():AgentTaskTools {mutable();if(!tools)throw agentTaskFailure('AGENT_TASK_CLOSED');return tools;}
  function runTools(run:AgentTaskRun){
    const definitions=toolset().list(),diagnostic=run.diagnostic;
    if(!diagnostic)return definitions;
    if(diagnostic.profile==='text')return [];
    if(diagnostic.profile==='read_only')return definitions.filter(tool=>tool.risk==='read_only');
    return diagnostic.toolNames?definitions.filter(tool=>diagnostic.toolNames!.includes(tool.name)):definitions;
  }
  const configuration=(run:AgentTaskRun):AgentConfiguration=>parseAgentConfiguration(run.configuration,{selfPort:selfPort()});
  const owned=(projectId:string,id:string):AgentTaskRun=>{checkOpen();if(!hasTables)throw agentTaskFailure('AGENT_TASK_NOT_FOUND');const run=journal.run(id);if(run.projectId!==projectId)throw agentTaskFailure('AGENT_TASK_NOT_FOUND');return run;};
  function authorize(run:AgentTaskRun):void {
    try{authorizations.assertAuthorized({destination:deriveAgentEndpoint(configuration(run)),model:configuration(run).model,scope:'project_agent'});}
    catch(error){throw agentTaskFailure(code(error)==='AGENT_AUTHORIZATION_REQUIRED'?'AGENT_TASK_CONSENT_REQUIRED':'AGENT_TASK_STORAGE_UNAVAILABLE');}
  }
  function changeStatus(runId:string,status:AgentTaskRun['status'],reason?:string):void {const run=journal.run(runId);if(run.status!==status||run.pauseReason!==reason)journal.transition(runId,run.revision,status,reason);}
  function fence(runId:string,allowBackground=false):AgentTaskRun {
    mutable();const run=journal.run(runId);
    if(allowBackground&&['stopped','reverted','failed'].includes(run.status))throw agentTaskFailure('AGENT_TASK_STOPPED');
    authorize(run);
    if(allowBackground?!['running','awaiting_approval','completed'].includes(run.status):run.status!=='running')throw agentTaskFailure('AGENT_TASK_PAUSED');return run;
  }
  function acceptedTargets(step:AgentTaskStep):AgentTaskTarget[]{
    // Queue admission can itself change a bound target. Advance only through
    // the acceptance receipt saved in that transaction, never the current DB.
    const executed=record(step.data)&&Array.isArray(step.data.executedTargets)?step.data.executedTargets as unknown as AgentTaskTarget[]:[];
    return (step.targets??[]).map(target=>{const saved=executed.find(item=>item.kind===target.kind&&item.id===target.id);return saved?{...target,revision:saved.revision}:target;});
  }
  const dispatchTargets=(step:AgentTaskStep):AgentTaskTarget[]=>record(step.data)&&Array.isArray(step.data.dispatchApprovalTargets)?step.data.dispatchApprovalTargets as unknown as AgentTaskTarget[]:acceptedTargets(step);
  const approvalDigest=(step:AgentTaskStep):string=>createHash('sha256').update(JSON.stringify({call:step.toolCall,targets:step.targets,tier:step.tier,...(record(step.data)&&Array.isArray(step.data.dispatchApprovalTargets)?{dispatchTargets:step.data.dispatchApprovalTargets}:{})})).digest('hex');
  const approved=(step:AgentTaskStep):boolean=>record(step.data)&&step.data.approvalDigest===approvalDigest(step);
  const skippedMessage=(run:AgentTaskRun):string=>skippedInstructions[taskResponseLocale(run.context)];
  function assertNotSkipped(run:AgentTaskRun,targets:AgentTaskTarget[]):void {
    if(targets.some(target=>run.skippedTargets?.some(item=>item.target.kind===target.kind&&item.target.id===target.id)))throw agentTaskFailure('AGENT_TASK_TARGET_SKIPPED');
  }
  function rememberConflict(runId:string,stepId:string,targets:AgentTaskTarget[]):void {
    const current=journal.step(stepId),known=[...(current.targets??[])];
    for(const target of targets)if(!known.some(item=>item.kind===target.kind&&item.id===target.id))known.push(target);
    journal.updateStep(runId,stepId,{targets:known,data:{...(record(current.data)?current.data:{}),conflictTargets:json(targets)}});
  }
  const removeGate=readOnly?()=>{}:setAgentTaskEffectGate(store.db,binding=>{
    mutable();const step=journal.step(binding.stepId);
    if(record(step.data)&&step.data.backgroundDenied===true)throw agentTaskFailure('AGENT_TASK_STOPPED');
    const run=fence(binding.runId,true);
    if(run.projectId!==binding.projectId||step.runId!==run.id)throw agentTaskFailure('AGENT_TASK_NOT_FOUND');
    assertNotSkipped(run,dispatchTargets(step));
    try{journal.assertTargets(run.projectId,dispatchTargets(step));}catch(error){
      const failure=code(error);if(failure==='AGENT_TASK_TARGET_CHANGED'||failure==='AGENT_TASK_TARGET_CLAIMED'){
        const invalidate=()=>{rememberConflict(run.id,step.id,journal.conflictingTargets(run.projectId,dispatchTargets(step)));const current=journal.step(step.id);journal.updateStep(run.id,step.id,{data:{...(record(current.data)?current.data:{}),backgroundInvalidated:true}});pause(run.id,failure==='AGENT_TASK_TARGET_CHANGED'?'conflict':'editing');};
        if(store.db.isTransaction)invalidate();else store.tx(invalidate);
      }throw error;
    }
    if(step.tier&&journal.policy().modes[step.tier]==='confirm'&&!approved(step)){
      const requestApproval=()=>{const current=journal.step(step.id);if(!record(current.data)||current.data.backgroundApprovalRequired!==true)journal.updateStep(run.id,step.id,{data:{...(record(current.data)?current.data:{}),backgroundApprovalRequired:true,dispatchApprovalTargets:json(dispatchTargets(current))}});if(journal.run(run.id).status!=='awaiting_approval')changeStatus(run.id,'awaiting_approval');};
      if(store.db.isTransaction)requestApproval();else store.tx(requestApproval);
      throw agentTaskFailure('AGENT_TASK_APPROVAL_REQUIRED');
    }
  });
  function toolFence(runId:string,stepId:string,prepared:PreparedAgentTaskTool):void {
    const run=fence(runId),step=journal.step(stepId);
    if(step.runId!==run.id||step.status==='rejected'||step.status==='denied')throw agentTaskFailure('AGENT_TASK_PAUSED');
    assertNotSkipped(run,prepared.referencedTargets??prepared.targets);
    if(journal.policy().modes[prepared.risk]==='confirm'&&!approved(step))throw agentTaskFailure('AGENT_TASK_APPROVAL_REQUIRED');
    journal.assertTargets(run.projectId,prepared.targets);
  }
  function pause(runId:string,reason:string):void {const run=journal.run(runId);if(!terminal(run)||run.status==='completed'&&journal.hasPendingBackground(runId))changeStatus(runId,'paused',reason);}
  function targetBaseline(step:AgentTaskStep):AgentTaskTarget[]{return record(step.data)&&Array.isArray(step.data.baseline)?step.data.baseline as unknown as AgentTaskTarget[]:[];}
  function modelConflictingTargets(prepared:PreparedAgentTaskTool,source:AgentTaskStep):AgentTaskTarget[] {
    const baseline=targetBaseline(source),known=new Map(baseline.map(target=>[`${target.kind}:${target.id}`,target.revision]));
    const advance=(target:AgentTaskTarget):void=>{const identity=`${target.kind}:${target.id}`;known.set(identity,Math.max(known.get(identity)??0,target.revisionAfter??target.revision));};
    // Advance only through this batch's saved Changes and transactional target
    // receipts, never by refreshing all revisions after an async yield.
    const snapshot=journal.snapshot(source.runId);
    for(const change of snapshot.changes)if(change.status==='applied')for(const target of change.targets){
      const changeStep=journal.step(change.stepId);if(record(changeStep.data)&&changeStep.data.sourceModelStepId===source.id)advance(target);
    }
    for(const step of snapshot.steps)if(step.status==='completed'&&record(step.data)&&step.data.sourceModelStepId===source.id&&Array.isArray(step.data.executedTargets))for(const target of step.data.executedTargets as unknown as AgentTaskTarget[])advance(target);
    return prepared.targets.filter(target=>(known.get(`${target.kind}:${target.id}`)??0)!==target.revision);
  }
  async function performTool(runId:string,source:AgentTaskStep,call:TaskModelOutput['toolCalls'][number],signal:AbortSignal):Promise<AgentTaskStep|null>{
    let step=journal.snapshot(runId).steps.find(item=>record(item.data)&&item.data.sourceModelStepId===source.id&&item.toolCall?.id===call.id);
    if(step&&['completed','rejected','denied','failed'].includes(step.status))return step;
    if(step&&['unknown','dispatch_started'].includes(step.status))throw agentTaskFailure('AGENT_TASK_UNKNOWN_RESULT');
    if(!step&&record(source.data)&&source.data.toolsInvalidated===true){
      const current=fence(runId);let kept=false;
      try{const pending=toolset().prepare({projectId:current.projectId,operation:call.name,input:call.arguments,beforeTargetRead:target=>assertNotSkipped(current,[{...target,revision:0}])});kept=(pending.referencedTargets??pending.targets).some(target=>current.skippedTargets?.some(item=>item.target.kind===target.kind&&item.target.id===target.id));}
      catch(error){if(storageError(error))throw error;if(code(error)==='AGENT_TASK_TARGET_SKIPPED')kept=true;}
      return {...source,kind:'tool',status:kept?'denied':'rejected',toolCall:call,result:{error:{code:kept?'TARGET_SKIPPED':'TARGET_CHANGED',message:kept?skippedMessage(current):'此批旧工具参数已失效，请按当前保存状态重新规划。'}}};
    }
    const run=fence(runId);let prepared:PreparedAgentTaskTool|undefined,conflicts:AgentTaskTarget[]=[];
    // Diagnostic selection is a host-only restriction, never an authority. In
    // particular, catalog probes describe write tools without executing them.
    if(run.diagnostic&&(run.diagnostic.profile!=='read_only'||!runTools(run).some(tool=>tool.name===call.name)))throw agentTaskFailure('AGENT_TASK_DIAGNOSTIC_TOOL_FORBIDDEN');
    if(!step){const explanation=taskToolExplanation(modelOutput(source.result),call.id);step=journal.beginStep(runId,{kind:'tool',toolCall:call,...(explanation?{text:explanation}:{}),data:{sourceModelStepId:source.id}});}
    try {
      prepared=toolset().prepare({projectId:run.projectId,operation:call.name,input:call.arguments,beforeTargetRead:target=>assertNotSkipped(journal.run(runId),[{...target,revision:0}])});
      if(['asset.importSelected','lut.importSelected'].includes(prepared.operation)&&(!Array.isArray(run.attachments)||!run.attachments.includes(String(prepared.input.handle))))throw agentTaskFailure('AGENT_TASK_CONSENT_REQUIRED');
      assertNotSkipped(journal.run(runId),prepared.referencedTargets??prepared.targets);
      if(step.targets&&!isDeepStrictEqual(step.targets,prepared.targets)){
        conflicts=[...step.targets.filter(target=>!prepared!.targets.some(item=>item.kind===target.kind&&item.id===target.id&&item.revision===target.revision)),...prepared.targets.filter(target=>!step!.targets!.some(item=>item.kind===target.kind&&item.id===target.id))];
        throw agentTaskFailure('AGENT_TASK_TARGET_CHANGED');
      }
      step=journal.updateStep(runId,step.id,{targets:prepared.targets,tier:prepared.risk});
      conflicts=modelConflictingTargets(prepared,source);if(conflicts.length)throw agentTaskFailure('AGENT_TASK_TARGET_CHANGED');
      journal.assertTargets(run.projectId,prepared.targets);
      if(journal.policy().modes[prepared.risk]==='confirm'&&!approved(step)){
        journal.updateStep(runId,step.id,{status:'awaiting_approval'});changeStatus(runId,'awaiting_approval');return null;
      }
      toolFence(runId,step.id,prepared);journal.markDispatch(runId,step.id);
      const stepId=step.id,accepted=prepared;
      const outcome=await toolset().execute(accepted,{runId,stepId,requestId:stepId,signal,beforeEffect:()=>toolFence(runId,stepId,accepted),
        recordInside:(result,changes)=>{
          journal.completeStepInside(runId,stepId,{result,changes});
          const saved=journal.step(stepId);
          // Same-value mutations can advance a target without a visible Change.
          // Capture only these verified targets, inside the same domain commit.
          if(accepted.targets.length)journal.updateStep(runId,stepId,{data:{...(record(saved.data)?saved.data:{}),executedTargets:json(accepted.targets.map(target=>({...target,revision:journal.targetRevision(accepted.projectId,target.kind,target.id)})))}});
        },
        appendChangesInside:changes=>{journal.appendChangesInside(runId,stepId,changes);}});
      if(closed)return null;
      const current=journal.step(stepId);
      if(current.status!=='completed')journal.completeStep(runId,stepId,{result:outcome.result,changes:outcome.changes});
      return journal.step(stepId);
    }catch(error){
      if(closed)return null;const failure=code(error);
      if(storageError(error)){storageFaulted=true;for(const entry of active.values())entry.controller.abort();throw agentTaskFailure('AGENT_TASK_STORAGE_UNAVAILABLE');}
      if(['AGENT_TASK_TARGET_CHANGED','AGENT_TASK_TARGET_CLAIMED','AGENT_TASK_APPROVAL_REQUIRED','AGENT_TASK_PAUSED','AGENT_TASK_ABORTED','ABORT_ERR'].includes(failure)){
        if(journal.step(step.id).status==='dispatch_started')journal.dispatchPrevented(runId,step.id,failure==='AGENT_TASK_APPROVAL_REQUIRED'?'awaiting_approval':'intent');
        if(failure==='AGENT_TASK_TARGET_CHANGED'||failure==='AGENT_TASK_TARGET_CLAIMED')rememberConflict(runId,step.id,conflicts.length?conflicts:journal.conflictingTargets(run.projectId,journal.step(step.id).targets??prepared?.targets??[]));
        if(failure==='AGENT_TASK_APPROVAL_REQUIRED'){journal.updateStep(runId,step.id,{status:'awaiting_approval'});changeStatus(runId,'awaiting_approval');}
        else pause(runId,failure==='AGENT_TASK_TARGET_CLAIMED'?'editing':failure==='AGENT_TASK_TARGET_CHANGED'?'conflict':'user');return null;
      }
      if(failure==='AGENT_TASK_UNKNOWN_RESULT'){journal.updateStep(runId,step.id,{status:'unknown'});pause(runId,'unknown_outcome');return null;}
      if(failure==='AGENT_TASK_TARGET_SKIPPED'){
        if(journal.step(step.id).status==='dispatch_started')journal.dispatchPrevented(runId,step.id,'intent');
        return journal.updateStep(runId,step.id,{status:'denied',result:{error:{code:'TARGET_SKIPPED',message:skippedMessage(journal.run(runId))}},error:{code:'TARGET_SKIPPED',message:skippedMessage(journal.run(runId))}});
      }
      if(failure==='AGENT_TASK_CONSENT_REQUIRED'||failure==='AGENT_TASK_STORAGE_UNAVAILABLE')throw error;
      const current=journal.step(step.id);if(current.status==='completed')throw error;
      const uncertain=current.status==='dispatch_started'&&(!record(error)||!record(error.details)||error.details.mutationOutcome!=='not_applied');
      if(uncertain&&prepared?.risk!=='read_only'){
        journal.updateStep(runId,step.id,{status:'unknown',error:{code:failure,message:'工具结果未知，请核对原请求。'}});pause(runId,'unknown_outcome');return null;
      }
      return journal.updateStep(runId,step.id,{status:'failed',result:{error:{code:failure,message:'工具未完成，请检查参数或可用性。'}},error:{code:failure,message:'工具未完成，请检查参数或可用性。'}});
    }
  }
  async function execute(runId:string,signal:AbortSignal):Promise<void>{
    try {
      let run=fence(runId);const config=configuration(run),expected={expectedRevision:run.settingsRevision??0,configuration:config};
      const credential=await new Promise<Awaited<ReturnType<AgentSettingsService[typeof AGENT_CREDENTIAL_ACQUIRE]>>>((resolve,reject)=>{
        const abort=()=>reject(agentTaskFailure('AGENT_TASK_PAUSED'));signal.addEventListener('abort',abort,{once:true});
        Promise.resolve().then(()=>{fence(runId);return agentSettings[AGENT_CREDENTIAL_ACQUIRE](expected,{selfPort:selfPort(),signal});}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
      });
      const acquired=sanitizeAgentCredentialResult(credential,expected);if(!acquired)throw agentTaskFailure('AGENT_TASK_SETTINGS_CHANGED');const key=acquired.apiKey;fence(runId);
      for(;;){
        run=fence(runId);const snapshot=journal.snapshot(runId),history:AgentTaskJson[]=structuredClone(run.context??[{role:'user',content:run.text}]);
        let resumeModel:AgentTaskStep|undefined,pendingModel:AgentTaskStep|undefined;
        for(const model of snapshot.steps.filter(item=>item.kind==='model')){
          history.push(...(run.notes??[]).filter(note=>note.modelStepId===model.id).map(note=>({role:'user',content:note.text})));
          if(model.status==='failed'&&record(model.result)&&model.result.discarded===true){history.push({role:'user',content:'上一次模型请求结果未知，用户已将其标记为失败。请重新读取当前保存状态后继续，不要假定此前有工具执行。'});continue;}
          if(model.status==='intent'){pendingModel=model;break;}
          if(model.status!=='completed')throw agentTaskFailure('AGENT_TASK_UNKNOWN_RESULT');
          const output=modelOutput(model.result);
          if(!output.toolCalls.length||run.diagnostic?.profile==='catalog'){
            if(record(model.data)&&model.data.replanRequested===true){history.push(...taskContinuation(config.protocol,output,[]),{role:'user',content:'原排队操作因目标冲突已取消。请重新读取当前保存状态后规划，不要重放旧参数或假定生成已提交。'});continue;}
            if(record(model.data)&&model.data.noteContinuationRequested===true||(journal.run(runId).notes??[]).some(note=>note.modelStepId===undefined)){
              if(!record(model.data)||model.data.noteContinuationRequested!==true)journal.updateStep(runId,model.id,{data:{...(record(model.data)?model.data:{}),noteContinuationRequested:true}});
              const diagnosticResults=output.toolCalls.map(call=>({callId:call.id,result:{error:{code:'DIAGNOSTIC_NOT_EXECUTED'}}}));
              history.push(...taskContinuation(config.protocol,output,diagnosticResults));resumeModel=model;continue;
            }
            changeStatus(runId,'completed');return;
          }
          const results:{callId:string;result:AgentTaskJson}[]=[];
          for(const call of output.toolCalls){
            const finished=await performTool(runId,model,call,signal);if(!finished)return;
            results.push({callId:call.id,result:finished.result??{error:{code:finished.status}}});
          }
          history.push(...taskContinuation(config.protocol,output,results));resumeModel=model;
        }
        run=fence(runId);const pendingNotes=pendingModel?[]:(run.notes??[]).filter(note=>note.modelStepId===undefined);
        history.push(...pendingNotes.map(note=>({role:'user',content:note.text})));
        const body=pendingModel&&record(pendingModel.request)&&typeof pendingModel.request.body==='string'?pendingModel.request.body:buildTaskModelRequest(config,history,runTools(run),selfPort()),model=pendingModel??journal.beginModelStep(runId,{request:{body,history},data:{baseline:json(journal.revisionSnapshot(run.projectId)),...(resumeModel?{previousModelStepId:resumeModel.id}:{})}},pendingNotes.map(note=>note.requestId));
        journal.markDispatch(runId,model.id);let output:TaskModelOutput|null=null,pending='',lastFlush=Date.now();
        const flush=()=>{if(pending&&!closed){journal.appendText(runId,model.id,pending);pending='';lastFlush=Date.now();}};
        for await(const item of gateway({configuration:config,body,apiKey:key,signal,selfPort:selfPort(),beforeSubmit:()=>{fence(runId);}})){
          if(closed||journal.run(runId).status==='stopped')return;
          if(output)throw agentTaskFailure('AGENT_TASK_FAILED');
          if(item.type==='delta'){pending+=item.text;if(Buffer.byteLength(pending)>2048||Date.now()-lastFlush>50)flush();}
          else output=item.output;
        }
        flush();if(!output)throw agentTaskFailure('AGENT_TASK_UNKNOWN_RESULT');
        journal.completeStep(runId,model.id,{result:json(output)});
        if(journal.run(runId).status!=='running')return;
      }
    }catch(error){
      if(closed)return;
      if(wasTaskSubmissionPrevented(error))for(const step of journal.snapshot(runId).steps)if(step.kind==='model'&&step.status==='dispatch_started')journal.dispatchPrevented(runId,step.id,'intent');
      const run=journal.run(runId);if(terminal(run)||run.status==='paused'||run.status==='awaiting_approval')return;
      const failure=code(error);
      if(failure==='AGENT_TASK_BUDGET_EXHAUSTED'){pause(runId,'budget');return;}
      const message=agentChatHttpStatus(error)===undefined?agentTaskFailure(failure).message:safeAgentChatError(error).message;
      for(const step of journal.snapshot(runId).steps)if(step.status==='dispatch_started')journal.updateStep(runId,step.id,{status:'unknown',error:{code:failure,message}});
      if(failure==='AGENT_TASK_UNKNOWN_RESULT'){pause(runId,'unknown_outcome');return;}
      changeStatus(runId,'failed',failure);journal.appendEvent(runId,'error',{code:failure,message});
    }
  }
  function launch(runId:string):void {
    const current=active.get(runId);if(current){current.restartRequested=true;return;}if(closed||storageFaulted)return;
    const controller=new AbortController(),entry:Active={controller,promise:Promise.resolve(),restartRequested:false};active.set(runId,entry);
    const failClosed=()=>{
      // Even recording the failure may fail. Keep the durable intent for explicit
      // recovery and fence this runtime; never retry an executor automatically.
      storageFaulted=true;for(const task of active.values())task.controller.abort();
    };
    entry.promise=execute(runId,controller.signal).catch(failClosed).finally(()=>{if(active.get(runId)===entry)active.delete(runId);if(entry.restartRequested&&!closed&&!storageFaulted&&journal.run(runId).status==='running')queueMicrotask(()=>launch(runId));}).catch(failClosed);
  }
  async function snapshot(projectId:string){checkOpen();if(!store.get('projects',projectId))throw agentTaskFailure('AGENT_TASK_NOT_FOUND');const settings=sanitizeAgentSettingsResult(await agentSettings.get({selfPort:selfPort()}));return {version:2 as const,instanceId,projectId,readOnly,runs:(hasTables?journal.list(projectId,{excludeDiagnostics:true}):[]).map(run=>{const {context,...summary}=run;return summary;}),policy:hasTables?journal.policy():structuredClone(DEFAULT_AGENT_TASK_POLICY),settings,authorization:authorizations.snapshot(settings.configuration)};}
  async function send(projectId:string,input:unknown):Promise<AgentTaskSnapshot>{
    mutable();if(!record(input)||Object.keys(input).some(key=>!['requestId','text','expectedSettingsRevision','expectedRevision','locale','uploads','diagnostic','conversationId'].includes(key))||typeof input.requestId!=='string'||input.requestId.length<8||input.requestId.length>200||typeof input.text!=='string'||!input.text.trim()||Buffer.byteLength(input.text)>32*1024||!Number.isSafeInteger(input.expectedSettingsRevision)||input.uploads!==undefined&&(!Array.isArray(input.uploads)||input.uploads.length>20||input.uploads.some(id=>typeof id!=='string'||!/^[-a-f0-9]{36}$/u.test(id))))throw agentTaskFailure('AGENT_TASK_INVALID');
    const parsedLocale=agentTaskLocaleSchema.safeParse(input.locale===undefined?DEFAULT_AGENT_TASK_LOCALE:input.locale);if(!parsedLocale.success)throw agentTaskFailure('AGENT_TASK_INVALID');const locale=parsedLocale.data;
    const parsedDiagnostic=input.diagnostic===undefined?undefined:agentTaskDiagnosticSchema.safeParse(input.diagnostic);
    if(parsedDiagnostic&&!parsedDiagnostic.success)throw agentTaskFailure('AGENT_TASK_INVALID');
    const diagnostic=parsedDiagnostic?.success?parsedDiagnostic.data:undefined;
    if(diagnostic?.toolNames?.some(name=>!toolset().list().some(tool=>tool.name===name)))throw agentTaskFailure('AGENT_TASK_INVALID');
    const uploads=(input.uploads??[]) as string[];
    if(input.conversationId!==undefined&&(typeof input.conversationId!=='string'||!/^[-a-f0-9]{36}$/iu.test(input.conversationId)||diagnostic))throw agentTaskFailure('AGENT_TASK_INVALID');
    const conversationId=input.conversationId as string|undefined;
    const previous=journal.lookupRequest(projectId,input.requestId);if(previous){if(previous.run.text!==input.text||taskResponseLocale(previous.run.context)!==locale||!isDeepStrictEqual(previous.run.attachments??[],uploads)||!isDeepStrictEqual(previous.run.diagnostic,diagnostic))throw agentTaskFailure('AGENT_TASK_REQUEST_CONFLICT');if(journal.requestConversationId(previous.run.id)!==conversationId)throw agentTaskFailure('AGENT_TASK_REQUEST_CONFLICT');return safeSnapshot(previous,store);}
    const settings=sanitizeAgentSettingsResult(await agentSettings.get({selfPort:selfPort()}));if(settings.revision!==input.expectedSettingsRevision)throw agentTaskFailure('AGENT_TASK_SETTINGS_CHANGED');
    const dummy={configuration:json(settings.configuration)} as AgentTaskRun;authorize(dummy);
    const groups:AgentTaskJson[][]=[];for(const old of (diagnostic||!conversationId?[]:journal.contextRuns(projectId,conversationId)).reverse()){
      const final=journal.snapshot(old.id).steps.filter(step=>step.kind==='model'&&step.status==='completed').at(-1);if(final&&record(final.result)&&typeof final.result.text==='string')groups.push([{role:'user',content:old.text},...(old.notes??[]).map(note=>({role:'user',content:note.text})),{role:'assistant',content:final.result.text}]);
    }
    const attachments=uploads.map(id=>{const row=store.db.prepare('SELECT id,name,mimeType FROM agent_task_imports_v2 WHERE id=? AND projectId=?').get(id,projectId);if(!row)throw agentTaskFailure('AGENT_TASK_NOT_FOUND');return {handle:String(row.id),name:String(row.name),mimeType:String(row.mimeType)};});
    const currentMessage:AgentTaskJson={role:'user',content:input.text+(attachments.length?`\n${attachmentInstructions[locale]}${JSON.stringify(attachments)}`:'')};
    let context:AgentTaskJson[]=[taskResponseLanguageContext(locale),...groups.flat(),currentMessage];
    while(groups.length&&Buffer.byteLength(JSON.stringify(context))>TASK_MODEL_LIMITS.historyBytes){groups.shift();context=[taskResponseLanguageContext(locale),...groups.flat(),currentMessage];}
    if(active.size>=4)throw agentTaskFailure('AGENT_TASK_BUSY');
    mutable();
    const created=journal.create({projectId,...(conversationId?{conversationId}:{}),requestId:input.requestId,text:input.text,configuration:json(settings.configuration),settingsRevision:settings.revision,context,attachments:uploads,...(diagnostic?{diagnostic}:{})});launch(created.run.id);return safeSnapshot(journal.snapshot(created.run.id),store);
  }
  async function action(projectId:string,runId:string,input:unknown):Promise<AgentTaskSnapshot>{
    mutable();const parsed=agentTaskControlSchema.safeParse(record(input)?{...input,runId}:input);if(!parsed.success)throw agentTaskFailure('AGENT_TASK_INVALID');const request=parsed.data;
    const undo=request.action==='undo_change'||request.action==='undo_all';
    const old=journal.lookupControl(request.requestId);if(old){owned(projectId,runId);if(undo)journal.beginControl(request);else journal.performControl(request,()=>null);return safeSnapshot(journal.snapshot(runId),store);}
    let run=owned(projectId,runId);const cancelBackgroundSteps:string[]=[];try{if(run.revision!==request.expectedRevision)throw agentTaskFailure('AGENT_TASK_REVISION_CONFLICT');
    if(request.action==='undo_change'||request.action==='undo_all'){
      if(!terminal(run))throw agentTaskFailure('AGENT_TASK_PAUSED');
      journal.beginControl(request);
      const candidates=journal.snapshot(runId).changes.reverse();
      const chain=new Map<string,AgentTaskTarget>(),retainedChangeIds:string[]=[];
      try{for(const change of candidates){
        if(change.status==='reverted'){for(const target of change.revertedTargets??[])chain.set(`${target.kind}:${target.id}`,target);continue;}
        if(change.status!=='applied'||!change.reversible||request.action==='undo_change'&&change.id!==request.changeId)continue;
        // A saved compensation revision only bridges adjacent AI changes. It
        // must not jump across an intervening external edit, including ABA.
        const expectedTargets=change.targets.map(target=>{const next=chain.get(`${target.kind}:${target.id}`);return next&&next.revisionBefore===(target.revisionAfter??target.revision)?next:target;});
        const reverted=toolset().undo(change,{requestId:`${request.requestId}:${change.id}`,expectedTargets,beforeEffect:()=>{owned(projectId,runId);journal.assertTargets(projectId,expectedTargets);},recordInside:()=>{journal.markChangeRevertedInside(change.id);},retainInside:(_change,reason)=>{journal.markChangeRetainedInside(change.id,reason);}});
        if(reverted.retained){retainedChangeIds.push(change.id);continue;}
        for(const target of reverted.targets)chain.set(`${target.kind}:${target.id}`,target);
      }}catch(error){journal.finishControl(request.requestId,{state:'blocked',code:code(error),...(retainedChangeIds.length?{retainedChangeIds}:{})});throw error;}
      run=journal.run(runId);if(request.action==='undo_all'&&!journal.snapshot(runId).changes.some(change=>change.reversible&&change.status==='applied'))changeStatus(runId,'reverted');
      journal.finishControl(request.requestId,{state:'completed',...(retainedChangeIds.length?{retainedChangeIds}:{})});
    }else journal.performControl(request,():AgentTaskJson=>{
      run=owned(projectId,runId);if(run.revision!==request.expectedRevision)throw agentTaskFailure('AGENT_TASK_REVISION_CONFLICT');
      if(request.action==='note'){journal.appendNoteInside(runId,request.requestId,request.text);return {state:'completed',noteRequestId:request.requestId};}
      if(request.action==='pause'){if(run.status==='running'||run.status==='awaiting_approval'||run.status==='completed'&&journal.hasPendingBackground(runId))changeStatus(runId,'paused','user');}
      else if(request.action==='stop'){if(!terminal(run)||run.status==='completed'&&journal.hasPendingBackground(runId)){changeStatus(runId,'stopped');for(const step of journal.snapshot(runId).steps)if(step.status==='dispatch_started')journal.updateStep(runId,step.id,{status:'unknown'});}}
      else if(request.action==='approve'||request.action==='deny'){
        if(run.status!=='awaiting_approval'||!request.stepId)throw agentTaskFailure('AGENT_TASK_INVALID');const step=journal.step(request.stepId),background=step.status==='completed'&&record(step.data)&&step.data.backgroundApprovalRequired===true;if(step.runId!==runId||step.status!=='awaiting_approval'&&!background)throw agentTaskFailure('AGENT_TASK_INVALID');
        if(request.action==='approve'){authorize(run);assertNotSkipped(run,background?dispatchTargets(step):step.targets??[]);journal.assertTargets(projectId,background?dispatchTargets(step):step.targets??[]);}
        if(background){journal.updateStep(runId,step.id,{data:{...(record(step.data)?step.data:{}),backgroundApprovalRequired:false,...(request.action==='approve'?{approvalDigest:approvalDigest(step)}:{backgroundDenied:true})}});if(request.action==='deny')cancelBackgroundSteps.push(step.id);}
        else journal.updateStep(runId,step.id,{status:request.action==='approve'?'intent':'rejected',data:{...(record(step.data)?step.data:{}),...(request.action==='approve'?{approvalDigest:approvalDigest(step)}:{})},...(request.action==='deny'?{result:{error:{code:'USER_REJECTED',message:'用户拒绝了此操作。'}}}:{})});
        journal.resume(runId,journal.run(runId).revision,{extendBudget:false});
      }else if(request.action==='resolve_unknown'){
        if(!request.stepId)throw agentTaskFailure('AGENT_TASK_INVALID');const step=journal.step(request.stepId);if(step.runId!==runId||step.status!=='unknown')throw agentTaskFailure('AGENT_TASK_UNKNOWN_RESULT');
        if(step.kind==='model'&&request.resolution==='discard')journal.updateStep(runId,step.id,{status:'failed',result:{discarded:true},error:{code:'USER_DISCARDED_UNKNOWN',message:'用户已将未知模型请求标记为失败。'}});
        else if(step.toolCall?.name==='mioon_task_wait'&&request.resolution==='accept_result'){
          const prepared=toolset().prepare({projectId,operation:step.toolCall.name,input:step.toolCall.arguments}),result=toolset().recoverWait(prepared);
          if(result===null)throw agentTaskFailure('AGENT_TASK_UNKNOWN_RESULT');journal.updateStep(runId,step.id,{status:'completed',result});
        }else if(step.toolCall&&request.resolution==='discard'){
          const prepared=toolset().prepare({projectId,operation:step.toolCall.name,input:step.toolCall.arguments}),proof=toolset().recoverLocalUnknown(prepared,{runId,stepId:step.id,requestId:step.id});
          if(!proof)throw agentTaskFailure('AGENT_TASK_UNKNOWN_RESULT');journal.updateStep(runId,step.id,{status:'failed',result:{...proof,error:{code:'UNKNOWN_NOT_APPLIED',message:'已核对原子回执，旧步骤未提交。请重新读取当前状态后规划，不要重放旧参数。'}}});
        }else throw agentTaskFailure('AGENT_TASK_UNKNOWN_RESULT');
      }else if(request.action==='resume'||request.action==='skip'){
        authorize(run);const conflict=run.pauseReason==='conflict'||run.pauseReason==='editing';
        if(request.action==='resume'&&conflict)throw agentTaskFailure('AGENT_TASK_SKIP_REQUIRED');
        if(request.action==='skip'&&(run.status!=='paused'||!conflict))throw agentTaskFailure('AGENT_TASK_INVALID');
        let skipped:AgentTaskTarget[]=[];
        if(request.action==='skip'){
          const steps=journal.snapshot(runId).steps;
          const actual=steps.filter(step=>step.kind==='tool'&&record(step.data)&&Array.isArray(step.data.conflictTargets)&&(step.status==='intent'||step.status==='awaiting_approval'||step.status==='completed'&&step.data.backgroundInvalidated===true)).flatMap(step=>(step.data as unknown as {conflictTargets:AgentTaskTarget[]}).conflictTargets.map(target=>({stepId:step.id,target})));
          skipped=journal.skipTargetsInside(runId,actual).map(item=>item.target);
          const background=steps.filter(step=>step.status==='completed'&&record(step.data)&&(step.data.backgroundApprovalRequired===true||step.data.backgroundInvalidated===true)&&dispatchTargets(step).some(target=>skipped.some(item=>item.kind===target.kind&&item.id===target.id)));
          for(const step of background){journal.updateStep(runId,step.id,{data:{...(record(step.data)?step.data:{}),backgroundApprovalRequired:false,backgroundInvalidated:false,backgroundDenied:true}});cancelBackgroundSteps.push(step.id);}
          const final=steps.filter(step=>step.kind==='model'&&step.status==='completed').at(-1);
          if(background.length&&final&&!modelOutput(final.result).toolCalls.length)journal.updateStep(runId,final.id,{data:{...(record(final.data)?final.data:{}),replanRequested:true}});
          for(const model of steps.filter(step=>step.kind==='model'&&step.status==='completed')){
            const calls=modelOutput(model.result).toolCalls;
            if(calls.some(call=>!steps.some(step=>step.toolCall?.id===call.id&&record(step.data)&&step.data.sourceModelStepId===model.id&&['completed','denied','rejected','failed'].includes(step.status))))journal.updateStep(runId,model.id,{data:{...(record(model.data)?model.data:{}),toolsInvalidated:true}});
          }
          for(const step of steps)if(step.kind!=='model'&&(step.status==='intent'||step.status==='awaiting_approval')){
            const kept=(step.targets??[]).some(target=>journal.run(runId).skippedTargets?.some(item=>item.target.kind===target.kind&&item.target.id===target.id));
            journal.updateStep(runId,step.id,{status:kept?'denied':'rejected',result:{error:{code:kept?'TARGET_SKIPPED':'TARGET_CHANGED',message:kept?skippedMessage(run):'目标已变化，请按当前保存状态重新规划。'}}});
          }
        }
        journal.resume(runId,journal.run(runId).revision,{extendBudget:request.action==='resume'});
        if(request.action==='skip')return {state:'completed',skippedTargets:skipped.map(target=>({kind:target.kind,id:target.id}))};
      }
      return null;
    });
    if(request.action==='stop')active.get(runId)?.controller.abort();
    if(request.action==='stop'||request.action==='undo_all'&&journal.run(runId).status==='reverted')await stopAgentTaskJobs(store.db,runId);
    for(const stepId of cancelBackgroundSteps)await stopAgentTaskJobs(store.db,runId,stepId);
    if(request.action==='resume'||request.action==='skip'||request.action==='approve')resumeAgentTaskJobs(store.db,runId);
    if(journal.run(runId).status==='running')launch(runId);return safeSnapshot(journal.snapshot(runId),store);
    }catch(error){
      const failure=code(error);
      if(failure==='AGENT_TASK_TARGET_CHANGED'||failure==='AGENT_TASK_TARGET_CLAIMED'){
        if(request.action==='approve'&&request.stepId){const step=journal.step(request.stepId);rememberConflict(runId,step.id,journal.conflictingTargets(projectId,dispatchTargets(step)));}
        pause(runId,failure==='AGENT_TASK_TARGET_CHANGED'?'conflict':'editing');
      }
      if(storageError(error)){storageFaulted=true;for(const entry of active.values())entry.controller.abort();throw agentTaskFailure('AGENT_TASK_STORAGE_UNAVAILABLE');}
      journal.rejectControl(request,failure);throw error;
    }
  }
  return {journal,instanceId,readOnly,snapshot,send,action,
    isBusy:()=>active.size>0||hasTables&&!!store.db.prepare("SELECT 1 FROM agent_task_runs_v2 WHERE status IN ('accepted','running') LIMIT 1").get(),
    history:(projectId:string,cursor?:string)=>{checkOpen();if(!store.get('projects',projectId))throw agentTaskFailure('AGENT_TASK_NOT_FOUND');return hasTables?journal.history(projectId,{cursor}):{conversations:[],nextCursor:null};},
    conversation:(projectId:string,conversationId:string,cursor?:string)=>{checkOpen();if(!hasTables||!store.get('projects',projectId))throw agentTaskFailure('AGENT_TASK_NOT_FOUND');const page=journal.conversation(projectId,conversationId,{cursor});return {...page,runs:page.runs.map(run=>{const {context,...summary}=run;return summary;})};},
    timelineRevision:(projectId:string)=>{checkOpen();const row=store.db.prepare("SELECT json_extract(data,'$.revision') AS revision FROM timelines WHERE projectId=?").get(projectId);return row?Number(row.revision):null;},
    get:(projectId:string,id:string)=>{owned(projectId,id);return safeSnapshot(journal.snapshot(id),store);},
    lookup:(projectId:string,requestId:string)=>{checkOpen();const found=hasTables?journal.lookupRequest(projectId,requestId):null;return {found:!!found,...(found?{snapshot:safeSnapshot(found,store)}:{})};},
    lookupAction:(projectId:string,id:string,requestId:string)=>{owned(projectId,id);const found=journal.lookupControl(requestId);if(found&&found.runId!==id)throw agentTaskFailure('AGENT_TASK_NOT_FOUND');return {found:!!found,...(found?{snapshot:safeSnapshot(journal.snapshot(id),store),receipt:found}:{})};},
    lookupImport:(projectId:string,requestId:string)=>{mutable();const row=store.db.prepare('SELECT id,name,mimeType,status FROM agent_task_imports_v2 WHERE projectId=? AND requestId=?').get(projectId,requestId);return row?{id:String(row.id),name:String(row.name),mimeType:String(row.mimeType),status:String(row.status)}:null;},
    events:(projectId:string,id:string,after=0)=>{owned(projectId,id);const items=journal.events(id,after);return {sequence:items.at(-1)?.sequence??after,snapshot:safeSnapshot(journal.snapshot(id),store)};},
    policy:()=>hasTables?journal.policy():structuredClone(DEFAULT_AGENT_TASK_POLICY),lookupPolicy:(id:string)=>({found:hasTables&&!!journal.lookupPolicy(id),...(hasTables&&journal.lookupPolicy(id)?{policy:journal.lookupPolicy(id)}:{})}),updatePolicy:(input:unknown)=>{
      mutable();if(!record(input)||Object.keys(input).some(key=>!['requestId','expectedRevision','revision','stepLimit','modes','acknowledgePaid'].includes(key))||typeof input.requestId!=='string'||input.requestId.length<8||!record(input.modes))throw agentTaskFailure('AGENT_TASK_INVALID');
      const old=journal.policy();if(old.modes.paid!=='direct'&&input.modes.paid==='direct'&&input.acknowledgePaid!==true)throw agentTaskFailure('AGENT_TASK_APPROVAL_REQUIRED');
      return journal.updatePolicy({revision:input.expectedRevision??input.revision,stepLimit:input.stepLimit,modes:input.modes} as Parameters<AgentTaskJournal['updatePolicy']>[0],input.requestId);
    },
    close(){if(closed)return;closed=true;removeGate();for(const entry of active.values())entry.controller.abort();},
    async drain(){while(active.size)await Promise.allSettled([...active.values()].map(entry=>entry.promise));},
  };
}
export type AgentTaskRuntime=ReturnType<typeof createAgentTaskRuntime>;
