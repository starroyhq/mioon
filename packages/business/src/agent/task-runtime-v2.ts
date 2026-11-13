import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {AppError,deriveAgentEndpoint} from '@mioon/contracts';
import {agentTaskControlSchema,agentTaskConversationPolicySetSchema,agentTaskDiagnosticSchema,agentTaskLocaleSchema,agentTaskQuestionSchema,agentTaskSendSchema,agentTaskTargetSchema,DEFAULT_AGENT_TASK_LOCALE,DEFAULT_AGENT_TASK_POLICY} from '@mioon/contracts/agent-tasks-v2';
import type {AgentTaskJson,AgentTaskLocale,AgentTaskSnapshot,AgentTaskStep,AgentTaskTarget,AgentTaskRun} from '@mioon/contracts/agent-tasks-v2';
import type { Store } from '../store-contract.ts';
import {GENERATION_SERVICE_UNAVAILABLE} from '../provider-registry.ts';
import {mioTable} from './mio-table-layout.ts';
import {readMioRunUsage} from './mio-run-usage.ts';
import {isProjectStore} from '../project-file/store.ts';
import {assertProjectStore} from '../store-runtime.ts';
import {createMioProjectJournal} from './mio-journal-factory.ts';
import {createMioProjectRules} from './mio-rules.ts';
import type {MioProjectRules} from './mio-rules.ts';
import type {AgentPolicyStore} from '../app-db/stores.ts';
import {hasStoreTable} from '../store-layout.ts';
import {createAgentTaskJournal} from './task-journal-v2.ts';
import type {AgentTaskJournal} from './task-journal-v2.ts';
import type {AgentTaskTools,PreparedAgentTaskTool} from './task-tools-v2.ts';
import {MIO_PROJECT_FILE_IMPORT_OPERATION,MIO_PROJECT_FILE_IMPORT_TOOL,mioProjectFileImportResultSchema} from '../../../contracts/src/mio-project-import.ts';
import type {ProjectAssetImportLookup} from '../referenced-asset-project-import.ts';
import {agentTaskExplicitTargets,agentTaskChangeWasModified,projectAgentTaskUndo} from './task-tools-v2.ts';
import {setAgentTaskEffectGate,resumeAgentTaskJobs,stopAgentTaskJobs} from './task-effects-v2.ts';
import {AGENT_CREDENTIAL_ACQUIRE,sanitizeAgentCredentialResult,sanitizeAgentSettingsResult} from './settings.ts';
import type {AgentSettingsService} from './settings.ts';
import type {ChatAuthorizations} from './authorization-gate.ts';
import {agentDiagnosticSummarySchema} from '../../../contracts/src/agent-diagnostic-summary.ts';
import type {AgentDiagnosticSummary} from '../../../contracts/src/agent-diagnostic-summary.ts';
import {testProjectAppLibrary} from '../project-service-application.ts';
import type {AgentConfiguration} from './config.ts';
import {parseAgentConfiguration,agentSettingsError} from './config.ts';
import {agentChatDiagnostic,agentChatError,agentChatHttpStatus,agentChatStreamReason,safeAgentChatError} from './chat-errors.ts';
import {createTaskGateway,buildTaskModelRequest,taskContinuation,taskModelHistoryBudget,taskResponseLocale,taskToolExplanation,wasTaskSubmissionPrevented} from './task-gateway-v2.ts';
import type {TaskGateway,TaskHistoryBudget,TaskModelOutput,TaskModelItem} from './task-gateway-v2.ts';
import {taskModelUsage} from './task-usage-v2.ts';
import {assembleRunContext,assembleModelInput,cloneTaskBaseContext,selectTaskModelTools,sourceTaskModelToolNames,sourceTaskModelToolLoadMode,sourceTaskModelToolLoadInputAllowed} from './task-context-v2.ts';
import type {TaskModelContextFragment} from './task-context-v2.ts';
import {collectTaskProjectNotes,collectTaskProjectOverview} from './task-context-observations-v2.ts';
import {AGENT_TASK_ASK_OPERATION,AGENT_TASK_ASK_TOOL,AGENT_TASK_TOOLS_LOAD_NAME,agentTaskToolGroupForName} from './task-tool-groups-v2.ts';
import {agentTaskDisplayTargetReader,projectAgentTaskChangeDisplay,projectAgentTaskStepDisplay} from './task-display-v2.ts';
import {readAgentTaskChecks} from './task-checks-v2.ts';
import type {AgentTaskChecksPreflight} from './task-checks-v2.ts';
import {latestAgentTaskGoals} from './task-goals-v2.ts';

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const json=(value:unknown):AgentTaskJson=>JSON.parse(JSON.stringify(value??null)) as AgentTaskJson;
const code=(value:unknown):string=>record(value)&&typeof value.code==='string'?value.code:'AGENT_TASK_FAILED';
const storageError=(value:unknown):boolean=>/^(?:ERR_SQLITE|SQLITE_|AGENT_TASK_STORAGE_)/u.test(code(value));
const storageFailure=(value:unknown):string=>code(value)==='AGENT_TASK_STORAGE_LIMIT'||code(value)==='ERR_SQLITE_ERROR'&&record(value)&&value.message==='AGENT_TASK_STORAGE_LIMIT'?'AGENT_TASK_STORAGE_LIMIT':'AGENT_TASK_STORAGE_UNAVAILABLE';
const terminal=(run:AgentTaskRun):boolean=>['completed','failed','stopped','reverted'].includes(run.status);
const generationServiceUnavailableMessages:Record<AgentTaskLocale,string>={
  'zh-Hans':'没有可用的生成服务。这次生成没有提交，也没有产生生成费用。请停止重试，告诉用户先在设置 › 生成服务中配置并启用服务。',
  'zh-Hant':'沒有可用的生成服務。這次生成沒有提交，也沒有產生生成費用。請停止重試，告知使用者先在設定 › 生成服務中設定並啟用服務。',
  en:'No generation service is available for this request. This generation was not submitted and incurred no generation charges. Stop retrying and tell the user to configure and enable a service in Settings › Generation services.',
  ja:'このリクエストで利用できる生成サービスがありません。今回の生成は送信されず、生成料金も発生していません。再試行を止め、設定 › 生成サービスでサービスを設定して有効にするよう伝えてください。',
};
const imageServiceSelectionMessages:Record<AgentTaskLocale,string>={
  'zh-Hans':'配置了多个自定义图片服务。本次生成未提交，也没有产生生成费用。请告诉用户在图片生成面板中选择服务。',
  'zh-Hant':'設定了多個自訂圖片服務。本次生成未提交，也沒有產生生成費用。請告知使用者在圖片生成面板中選擇服務。',
  en:'Multiple custom image services are configured. This generation was not submitted and incurred no generation charges. Ask the user to select a service in the image generation panel.',
  ja:'複数のカスタム画像サービスが設定されています。今回の生成は送信されず、生成料金も発生していません。画像生成パネルでサービスを選ぶようユーザーに伝えてください。',
};
const isGenerationServiceDenial=(step:AgentTaskStep):boolean=>[GENERATION_SERVICE_UNAVAILABLE,'IMAGE_SETTINGS_SELECTION_REQUIRED','LIVE_GENERATION_DISABLED'].includes(step.error?.code??'')&&
  record(step.result)&&record(step.result.error)&&step.result.error.mutationOutcome==='not_applied';
const MAX_CONSECUTIVE_TOOL_FAILURES=3;
const MAX_MODEL_CALLS_WITHOUT_TOOL_SUCCESS=10;

const unsuccessfulTool=(step:AgentTaskStep):boolean=>step.kind==='tool'&&['rejected','denied','failed'].includes(step.status);
const settledTool=(step:AgentTaskStep):boolean=>step.kind==='tool'&&(step.status==='completed'||unsuccessfulTool(step));
const toolStepIdentity=(sourceModelStepId:string,callId:string):string=>JSON.stringify([sourceModelStepId,callId]);

function toolStepIds(steps:readonly AgentTaskStep[]):Map<string,string> {
  const result=new Map<string,string>();
  for(const step of steps){
    if(step.kind!=='tool'||!step.toolCall||!record(step.data)||typeof step.data.sourceModelStepId!=='string')continue;
    result.set(toolStepIdentity(step.data.sourceModelStepId,step.toolCall.id),step.id);
  }
  return result;
}

function businessToolArguments(value:AgentTaskJson):AgentTaskJson {
  if(!record(value)||!Object.hasOwn(value,'_mio_step'))return value;
  const {_mio_step,...args}=value;
  return args;
}

function repeatedToolFailure(steps:readonly AgentTaskStep[],afterPosition:number,lastStepId:string):boolean {
  let latest:AgentTaskStep['toolCall'],count=0;
  for(let index=steps.length-1;index>=0;index--){
    const step=steps[index]!;
    if(step.position<=afterPosition)break;
    if(step.kind!=='tool')continue;
    if(!unsuccessfulTool(step)||isGenerationServiceDenial(step)||!step.toolCall)return false;
    if(!latest){if(step.id!==lastStepId)return false;latest=step.toolCall;}
    if(step.toolCall.name!==latest.name||!isDeepStrictEqual(businessToolArguments(step.toolCall.arguments),businessToolArguments(latest.arguments)))return false;
    if(++count===MAX_CONSECUTIVE_TOOL_FAILURES)return true;
  }
  return false;
}

function noToolProgress(steps:readonly AgentTaskStep[],afterPosition:number):boolean {
  const successfulModels=new Set<string>();
  for(const step of steps){
    if(step.position<=afterPosition||step.kind!=='tool'||step.status!=='completed')continue;
    const sourceId=record(step.data)?step.data.sourceModelStepId:undefined;
    if(typeof sourceId==='string')successfulModels.add(sourceId);
  }
  let count=0;
  for(let index=steps.length-1;index>=0;index--){
    const step=steps[index]!;
    if(step.position<=afterPosition)break;
    if(step.kind!=='model')continue;
    const failedAttempt=step.status==='failed'&&!(record(step.data)&&step.data.dispatchPrevented===true);
    if(step.status!=='completed'&&!failedAttempt)continue;
    if(successfulModels.has(step.id))return false;
    if(++count===MAX_MODEL_CALLS_WITHOUT_TOOL_SUCCESS)return true;
  }
  return false;
}
// Failures this process observed from the model exchange itself. No tool runs
// before a model step completes, so the project is unchanged and the user may
// explicitly retry. Interrupted dispatches (no recorded outcome), storage
// faults and explicit unknown results keep the unknown rule.
const observedModelFailures=new Set(['AGENT_CHAT_CONNECT_FAILED','AGENT_CHAT_TIMEOUT','AGENT_CHAT_HTTP_ERROR','AGENT_CHAT_PROTOCOL_ERROR','AGENT_CHAT_TRUNCATED','AGENT_CHAT_PROVIDER_ERROR','AGENT_CHAT_LIMIT','AGENT_CHAT_TOOLS_UNSUPPORTED','AGENT_CHAT_REASONING_UNSUPPORTED','AGENT_CHAT_RESPONSES_REQUIRED','AGENT_CHAT_RESPONSES_ITEM_UNSUPPORTED','AGENT_CHAT_OUTPUT_LIMIT','AGENT_CHAT_RESPONSES_INCOMPLETE']);
const skippedInstructions:Record<AgentTaskLocale,string>={
  'zh-Hans':'这一处由用户保留，本轮不要再改。请继续处理其他未跳过的目标。',
  'zh-Hant':'這一處由使用者保留，本輪不要再修改。請繼續處理其他未略過的目標。',
  en:'The user kept this target. Do not modify it again in this run. Continue with other targets that have not been skipped.',
  ja:'この対象はユーザーが保持しました。この実行では再び変更しないでください。スキップしていない他の対象を続けて処理してください。',
};
// X4: a foreground step that meets a target conflict is not executed. Its
// result carries the saved values back to the model instead of pausing.
const CONFLICT_REREAD_CODES=new Set(['TARGET_CHANGED','TARGET_EDITING']);
const conflictInstructions:Record<'TARGET_CHANGED'|'TARGET_EDITING',Record<AgentTaskLocale,string>>={
  TARGET_CHANGED:{
    'zh-Hans':'目标在你读取后已被修改，这一步没有执行。current 是冲突目标当前保存的值，value 为 null 表示读取不到（可能已删除）。请按当前值重新判断；仍需修改时，用当前值重新调用，不要重放旧参数。',
    'zh-Hant':'目標在你讀取後已被修改，這一步沒有執行。current 是衝突目標目前儲存的值，value 為 null 表示讀取不到（可能已刪除）。請按目前的值重新判斷；仍需修改時，用目前的值重新呼叫，不要重放舊參數。',
    en:'The target changed after you read it, so this step did not run. current holds the saved value of each conflicting target; a null value means it could not be read, for example because it was deleted. Decide again from these values. If a change is still needed, call the tool again with the current values instead of replaying the old arguments.',
    ja:'読み取った後に対象が変更されたため、このステップは実行されませんでした。current は競合した各対象の現在の保存値です。value が null の場合は読み取れず、削除された可能性があります。この値をもとに判断し直し、まだ変更が必要なら、古い引数を再利用せず現在の値で改めて呼び出してください。',
  },
  TARGET_EDITING:{
    'zh-Hans':'用户正在手动编辑这一处，草稿还没保存，这一步没有执行。current 是当前保存的值，不含草稿。不要反复重试这一处；先处理其他部分，并在回复里说明这一处没有改。',
    'zh-Hant':'使用者正在手動編輯這一處，草稿還沒儲存，這一步沒有執行。current 是目前儲存的值，不含草稿。不要反覆重試這一處；先處理其他部分，並在回覆中說明這一處沒有修改。',
    en:'The user is editing this target and has not saved the draft, so this step did not run. current holds the saved value, without the draft. Do not retry this target repeatedly; continue with other work and say in your reply that it was not changed.',
    ja:'ユーザーがこの対象を手動で編集中で、下書きはまだ保存されていないため、このステップは実行されませんでした。current は保存済みの値で、下書きは含みません。この対象を繰り返し再試行せず、他の作業を続け、変更しなかったことを回答で伝えてください。',
  },
};
const invalidatedBatchInstructions:Record<AgentTaskLocale,string>={
  'zh-Hans':'此批旧工具参数已失效，请按当前保存状态重新规划。',
  'zh-Hant':'此批舊工具參數已失效，請按目前儲存狀態重新規劃。',
  en:'The old tool arguments in this batch are no longer valid. Replan from the current saved state.',
  ja:'このバッチの古いツール引数は無効になりました。現在の保存状態から計画し直してください。',
};
const userInvalidatedBatchInstructions:Record<'user_rejected'|'user_answered',Record<AgentTaskLocale,string>>={
  user_rejected:{
    'zh-Hans':'用户拒绝了此批计划中的一个操作，旧回复剩余调用没有执行。请尊重拒绝并重新规划，不要重放旧参数。',
    'zh-Hant':'使用者拒絕了此批計畫中的一個操作，舊回覆剩餘呼叫沒有執行。請尊重拒絕並重新規劃，不要重播舊參數。',
    en:'The user rejected an operation in this batch. Remaining calls from the old response did not run. Respect the refusal and replan instead of replaying old arguments.',
    ja:'ユーザーがこのバッチの操作を拒否したため、古い応答の残りは実行されませんでした。拒否を尊重し、古い引数を再利用せず計画し直してください。',
  },
  user_answered:{
    'zh-Hans':'用户已回答问题，获知回答以前计划的剩余调用没有执行。请先依据本次回答重新规划，不要重放旧参数。',
    'zh-Hant':'使用者已回答問題，得知回答以前規劃的剩餘呼叫沒有執行。請先依本次回答重新規劃，不要重播舊參數。',
    en:'The user answered the question. Remaining calls planned before that answer did not run. Replan from the answer instead of replaying old arguments.',
    ja:'ユーザーが質問に回答したため、その回答を知る前に計画した残りの呼び出しは実行されませんでした。回答に基づいて計画し直し、古い引数を再利用しないでください。',
  },
};
const loopInvalidatedBatchInstructions:Record<AgentTaskLocale,string>={
  'zh-Hans':'同一工具和参数连续失败或被拒，宿主已暂停执行。本批剩余调用没有执行。请按用户说明和当前状态重新规划。',
  'zh-Hant':'同一工具和參數連續失敗或被拒，宿主已暫停執行。本批其餘呼叫沒有執行。請按使用者說明和目前狀態重新規劃。',
  en:'The host paused after repeated failures or rejections for the same tool and arguments. The remaining calls in that batch did not run. Replan using the current state and any user instructions.',
  ja:'同じツールと引数で失敗または拒否が続いたため、ホストが一時停止しました。残りの呼び出しは実行されていません。現在の状態とユーザーの指示をもとに再計画してください。',
};
// X4 follow-up: a changed target set (a shot.reorder after a shot was added or
// deleted) can leave no saved value to hand back. Mio must reread the project.
const conflictProjectRereadInstructions:Record<AgentTaskLocale,string>={
  'zh-Hans':'目标在你读取后已变化，例如新增或删除了镜头，这一步没有执行。current 为空，没有可交回的值。请先重新读取项目，再按当前内容重新规划，不要重放旧参数。',
  'zh-Hant':'目標在你讀取後已變化，例如新增或刪除了鏡頭，這一步沒有執行。current 為空，沒有可交回的值。請先重新讀取專案，再按目前的內容重新規劃，不要重放舊參數。',
  en:'The targets changed after you read them, for example a shot was added or deleted, so this step did not run. current is empty because there is no saved value to return. Read the project again first, then replan from its current state instead of replaying the old arguments.',
  ja:'読み取った後に対象が変わったため（ショットの追加や削除など）、このステップは実行されませんでした。返せる保存値がないため current は空です。まずプロジェクトを読み直し、現在の状態から計画し直してください。古い引数を再利用しないでください。',
};
// X4 follow-up: the domain proved a stale revision in the arguments wrote
// nothing. Like a rejected parameter set, the step returns to Mio for a reread.
const revisionConflictInstructions:Record<AgentTaskLocale,string>={
  'zh-Hans':'参数里的修订号已过期，这一步没有执行，项目没有改动。请先重新读取目标的当前内容，再用新的修订号修改，不要重放旧参数。',
  'zh-Hant':'參數裡的修訂號已過期，這一步沒有執行，專案沒有變更。請先重新讀取目標目前的內容，再用新的修訂號修改，不要重放舊參數。',
  en:'The revision in your arguments is out of date, so this step did not run and nothing changed. Read the target again first, then make the change with its current revision instead of replaying the old arguments.',
  ja:'引数のリビジョンが古いため、このステップは実行されず、何も変更されていません。まず対象を読み直し、現在のリビジョンで変更してください。古い引数を再利用しないでください。',
};
const unloadedToolMessages:Record<AgentTaskLocale,string>={
  'zh-Hans':'此工具未包含在产生该回复的模型请求中。请先按确切工具名加载，再在下一次模型请求中调用。',
  'zh-Hant':'此工具未包含在產生該回覆的模型請求中。請先按確切工具名稱載入，再於下一次模型請求中呼叫。',
  en:'This tool was not included in the model request that produced this response. Load its exact tool name, then call it in the next model request.',
  ja:'この応答を生成したモデルリクエストに、このツールは含まれていません。正確なツール名で読み込み、次のモデルリクエストで呼び出してください。',
};
const invalidLoaderInputMessages:Record<AgentTaskLocale,string>={
  'zh-Hans':'加载参数与产生该回复的请求不匹配。请按该请求列出的工具名和参数重新加载，不要猜测工具名或改用工具组。',
  'zh-Hant':'載入參數與產生該回覆的請求不符。請依該請求列出的工具名稱和參數重新載入，不要猜測工具名稱或改用工具群組。',
  en:'The load arguments do not match the request that produced this response. Use only its listed tool names and parameter shape; do not guess names or switch to groups.',
  ja:'読み込み引数がこの応答を生成したリクエストと一致しません。そのリクエストに列挙されたツール名と引数の形だけを使用し、名前を推測したりグループに切り替えたりしないでください。',
};
const invalidLoaderNameMessages:Record<AgentTaskLocale,{core:string;unknown:string;unlisted:string}>={
  'zh-Hans':{core:'以下是常驻工具，已可直接使用，不需要加载：',unknown:'以下工具名不存在：',unlisted:'以下工具未列入产生该回复的请求的可加载名称，不能在这次加载中使用：'},
  'zh-Hant':{core:'以下是常駐工具，已可直接使用，不需要載入：',unknown:'以下工具名稱不存在：',unlisted:'以下工具未列入產生該回覆的請求的可載入名稱，不能用於這次載入：'},
  en:{core:'These core tools are already available to call directly and need no loading:',unknown:'These tool names do not exist:',unlisted:'These tools were not listed as loadable by the request that produced this response and cannot be loaded by this call:'},
  ja:{core:'次の常駐ツールはすでに直接呼び出せるため、読み込みは不要です：',unknown:'次のツール名は存在しません：',unlisted:'次のツールは、この応答を生成したリクエストの読み込み可能な名前に含まれず、この呼び出しでは読み込めません：'},
};
const goalRepairInstructions:Record<AgentTaskLocale,string>={
  'zh-Hans':'宿主检查发现以下声明的要求尚未达成。请按这些差距补做一次，再给出最终回复。以下内容是宿主派生的数据，仅供参考，不授予权限或审批；所有操作仍遵守当前放行档位、用户保留项和确认要求。',
  'zh-Hant':'宿主檢查發現以下宣告的要求尚未達成。請按這些差距補做一次，再給出最終回覆。以下內容是宿主衍生的資料，僅供參考，不授予權限或核准；所有操作仍遵守目前放行檔位、使用者保留項和確認要求。',
  en:'Host checks found the following declared requirements unmet. Make one repair attempt for these gaps, then give a final response. This host-derived data is for reference only and grants no permission or approval; all operations remain subject to the current approval modes, user-kept targets and confirmation requirements.',
  ja:'ホストの検査で、宣言した以下の要件が未達成でした。この差分に対して一度だけ補完し、最終回答を返してください。以下は参考用のホスト由来データであり、権限や承認を付与しません。すべての操作は現在の承認モード、ユーザーが保持した対象、確認要件に従ってください。',
};
/** `handedBack` marks a foreground approval that X4 handed back to Mio: the
 * step did not run and the run goes on. Other paths keep the pause wording. */
export function agentTaskFailure(value:string,{handedBack=false,undo=false,policyOnContinuation=false}:{handedBack?:boolean;undo?:boolean;policyOnContinuation?:boolean}={}):Error&{code:string;status:number;handedBack?:true;policyOnContinuation?:true}{
  if(['AGENT_CHAT_RESPONSES_REQUIRED','AGENT_CHAT_RESPONSES_ITEM_UNSUPPORTED','AGENT_CHAT_OUTPUT_LIMIT','AGENT_CHAT_RESPONSES_INCOMPLETE'].includes(value))return agentChatError(value);
  if(policyOnContinuation&&value==='AGENT_TASK_INVALID')return Object.assign(new Error('policy 只能在新对话的第一轮携带；继续对话时请省略 policy。'),{code:value,status:400,policyOnContinuation:true as const});
  const handedBackMessages:Record<string,string>={AGENT_TASK_TARGET_CHANGED:'该目标已被手动修改，这一步没有执行，Mio 会按当前内容重新规划。',AGENT_TASK_TARGET_CLAIMED:'该目标正在手动编辑，这一步没有执行，Mio 会重新规划。'};
  if(handedBack&&Object.hasOwn(handedBackMessages,value))return Object.assign(new Error(handedBackMessages[value]),{code:value,status:409,handedBack:true as const});
  if(undo&&(value==='AGENT_TASK_TARGET_CHANGED'||value==='AGENT_TASK_TARGET_CLAIMED'))return Object.assign(new Error(value==='AGENT_TASK_TARGET_CHANGED'?'目标已被修改，本次撤销没有完成。请检查当前保存状态。':'目标正在手动编辑，本次撤销没有完成。请检查当前保存状态。'),{code:value,status:409});
  const messages:Record<string,string>={AGENT_TASK_NOT_FOUND:'任务不存在。',AGENT_TASK_CLOSED:'任务服务已关闭。',AGENT_TASK_READ_ONLY:'恢复副本中的智能助理任务仅供查看。',AGENT_TASK_STOPPED:'任务已停止，尚未发出的工作已阻断。',AGENT_TASK_INVALID:'任务参数无效。',AGENT_TASK_BUSY:'本项目已有未结束任务，请继续或停止原任务。',AGENT_TASK_CONSENT_REQUIRED:'当前目标、模型和项目任务范围尚未授权，或授权已撤销。',AGENT_TASK_SETTINGS_CHANGED:'连接设置已变化，请重新确认目标和模型。',AGENT_TASK_NOT_CONFIGURED:'请先在设置中选择Mio使用的模型。',AGENT_TASK_TARGET_CHANGED:'该目标已被手动修改，任务已暂停。',AGENT_TASK_TARGET_CLAIMED:'该目标正在手动编辑，任务已暂停。',AGENT_TASK_UNKNOWN_RESULT:'上一步结果未知，请先核对原请求。',AGENT_TASK_REVISION_CONFLICT:'任务已被其他窗口更新，请重新读取。',AGENT_TASK_REQUEST_CONFLICT:'此请求标识已用于其他内容。',AGENT_TASK_STORAGE_LIMIT:'Mio 任务历史已达容量上限，已有记录保留，请先检查容量诊断。',AGENT_TASK_STORAGE_UNAVAILABLE:'无法安全读取或保存任务记录。',AGENT_TASK_FAILED:'任务未完成，请检查已保存记录。',AGENT_TASK_PAUSED:'任务已暂停。',AGENT_TASK_APPROVAL_REQUIRED:'此操作需要确认。'};
  return Object.assign(new Error(messages[value]??messages.AGENT_TASK_FAILED),{code:value,status:value==='AGENT_TASK_NOT_FOUND'?404:value==='AGENT_TASK_INVALID'?400:409});
}
function modelOutput(value:unknown):TaskModelOutput {
  if(!record(value)||typeof value.text!=='string'||!Array.isArray(value.toolCalls)||!Object.hasOwn(value,'providerOutput'))throw agentTaskFailure('AGENT_TASK_STORAGE_UNAVAILABLE');
  return value as unknown as TaskModelOutput;
}
function goalRepairMessage(step:AgentTaskStep):string|undefined {
  if(!record(step.data)||step.data.goalRepair===undefined)return;
  const marker=step.data.goalRepair;
  if(!record(marker)||marker.version!==1||typeof marker.message!=='string'||!marker.message.length)throw agentTaskFailure('AGENT_TASK_STORAGE_UNAVAILABLE');
  return marker.message;
}
function repairStepData(source:AgentTaskStep):Record<string,AgentTaskJson> {
  return record(source.data)&&typeof source.data.goalRepairSourceModelStepId==='string'?{goalRepairSourceModelStepId:source.data.goalRepairSourceModelStepId}:{};
}
function retainModelContinuation(protocol:AgentConfiguration['protocol'],fragments:TaskModelContextFragment[],fragment:Extract<TaskModelContextFragment,{kind:'continuation'}>):void {
  // Validate the retained provider output before any later batch may execute.
  // Null result probes preserve pairing checks without projecting or compacting
  // a context that has not reached its request boundary yet.
  taskContinuation(protocol,fragment.output,fragment.results.map(({callId})=>({callId,result:null})));
  fragments.push(fragment);
}
function retainedToolContextResult(step:AgentTaskStep|undefined):AgentTaskJson {
  if(!step||!['completed','rejected','denied','failed'].includes(step.status))return null;
  return step.result??{error:{code:step.status}};
}
function diagnosticHttpFailure({run,steps}:AgentTaskSnapshot):AgentDiagnosticSummary['diagnostic'] {
  if(run.status!=='failed'||run.pauseReason!=='AGENT_CHAT_HTTP_ERROR')return;
  const last=steps.at(-1);
  if(last?.kind==='model'&&last.status==='failed'&&last.error?.code===run.pauseReason&&last.error.diagnostic?.kind==='http')return last.error.diagnostic;
}
function safeSnapshot(value:AgentTaskSnapshot,store:Store):AgentTaskSnapshot {
  const copy=structuredClone(value),readTarget=agentTaskDisplayTargetReader(store,value.run.projectId);delete copy.run.context;
  const conflict=copy.run.status==='paused'&&['conflict','editing'].includes(copy.run.pauseReason??''),flagged=copy.steps.filter(step=>record(step.data)&&step.data.backgroundInvalidated===true),pending=copy.steps.filter(step=>step.kind==='tool'&&['intent','awaiting_approval'].includes(step.status)).at(-1);
  const skippedSteps=new Set(copy.run.skippedTargets?.map(item=>item.stepId)??[]);
  copy.steps=copy.steps.map(step=>{if(record(step.data)&&typeof step.data.goalRepairSourceModelStepId==='string')step.repair={sourceModelStepId:step.data.goalRepairSourceModelStepId};if(record(step.data)&&step.data.backgroundApprovalRequired===true){step.approvalRequired=true;if(Array.isArray(step.data.dispatchApprovalTargets))step.targets=step.data.dispatchApprovalTargets as unknown as AgentTaskTarget[];}const backgroundConflict=flagged.includes(step);step.display=projectAgentTaskStepDisplay(step,readTarget,skippedSteps.has(step.id)||conflict&&(backgroundConflict||flagged.length===0&&step===pending));if(step.display&&conflict&&backgroundConflict)step.display.conflict=true;delete step.request;delete step.data;if(step.kind==='model'&&record(step.result))step.result={text:typeof step.result.text==='string'?step.result.text:'',toolCalls:json(step.result.toolCalls??[])};return step;});
  const undoPreview=projectAgentTaskUndo(store,value.run.projectId,value.changes);
  copy.changes=copy.changes.map(change=>{Object.assign(change,undoPreview.get(change.id));change.display=projectAgentTaskChangeDisplay(change);change.before=null;change.after=null;delete change.undo;return change;});return copy;
}
interface Active {controller:AbortController;promise:Promise<void>;restartRequested:boolean}
export interface AgentTaskRuntimeOptions {store:Store;agentSettings:AgentSettingsService;authorizations:ChatAuthorizations;tools?:AgentTaskTools;selfPort:()=>number;gateway?:TaskGateway;journal?:AgentTaskJournal;policyStore?:AgentPolicyStore;rules?:MioProjectRules;readOnly?:boolean;assertMutationAllowed?:()=>void;checksPreflight?:AgentTaskChecksPreflight;onDiagnosticCompleted?:(summary:AgentDiagnosticSummary)=>void}
/** SQLite owns progress. Process-local state is only cancellation and a single
 * current executor; opening this runtime never restarts an interrupted run. */
export function createAgentTaskRuntime({store,agentSettings,authorizations,tools,selfPort,gateway=createTaskGateway(),policyStore=testProjectAppLibrary(store)?.agentPolicy,rules:injectedRules,journal:injectedJournal,readOnly=false,assertMutationAllowed,checksPreflight,onDiagnosticCompleted}:AgentTaskRuntimeOptions){
  assertProjectStore(store);
  const sourceJournal:AgentTaskJournal=injectedJournal??createMioProjectJournal(store,policyStore);
  const instanceId=randomUUID(),active=new Map<string,Active>();let closed=false,storageFaulted=false,storageFailureCode='AGENT_TASK_STORAGE_UNAVAILABLE';
  let rules=injectedRules;
  function captureRules(){
    if(!isProjectStore(store))return undefined;
    if(!rules){const application=testProjectAppLibrary(store);if(!application)throw agentTaskFailure('AGENT_TASK_STORAGE_UNAVAILABLE');rules=createMioProjectRules({store,application});}
    return rules.capture();
  }
  function failStorage(error:unknown):never {storageFaulted=true;storageFailureCode=storageFailure(error);for(const entry of active.values())entry.controller.abort();throw agentTaskFailure(storageFailureCode);}
  // A SQLite failure is an audit failure, including when it occurs in a domain
  // transaction callback. Never turn it into an ordinary failed tool result.
  const journal=new Proxy(sourceJournal,{get(target,property,receiver){const value:unknown=Reflect.get(target,property,receiver);if(typeof value!=='function')return value;return (...args:unknown[]):unknown=>{try{return Reflect.apply(value,target,args);}catch(error){if(storageError(error))failStorage(error);throw error;}};}});
  const hasTables=hasStoreTable(store.db,mioTable(store.db,'runs'));
  if(!readOnly)journal.recover();
  const checkOpen=():void=>{if(closed)throw agentTaskFailure('AGENT_TASK_CLOSED');};
  function mutable():void {checkOpen();if(readOnly)throw agentTaskFailure('AGENT_TASK_READ_ONLY');if(storageFaulted)throw agentTaskFailure(storageFailureCode);assertMutationAllowed?.();}
  function toolset():AgentTaskTools {mutable();if(!tools)throw agentTaskFailure('AGENT_TASK_CLOSED');return tools;}
  function runTools(run:AgentTaskRun){
    return selectTaskModelTools(run.diagnostic?toolset().diagnosticList():toolset().list(),run.diagnostic,run.diagnostic?{}:{steps:journal.snapshot(run.id).steps,attachments:run.attachments});
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
    if(allowBackground?!['running','awaiting_approval','awaiting_answer','completed'].includes(run.status):run.status!=='running')throw agentTaskFailure('AGENT_TASK_PAUSED');return run;
  }
  function acceptedTargets(step:AgentTaskStep):AgentTaskTarget[]{
    // Queue admission can itself change a bound target. Advance only through
    // the acceptance receipt saved in that transaction, never the current DB.
    const executed=record(step.data)&&Array.isArray(step.data.executedTargets)?step.data.executedTargets as unknown as AgentTaskTarget[]:[];
    return (step.targets??[]).map(target=>{const saved=executed.find(item=>item.kind===target.kind&&item.id===target.id);return saved?{...target,revision:saved.revision}:target;});
  }
  const dispatchTargets=(step:AgentTaskStep):AgentTaskTarget[]=>record(step.data)&&Array.isArray(step.data.dispatchApprovalTargets)?step.data.dispatchApprovalTargets as unknown as AgentTaskTarget[]:acceptedTargets(step);
  function referencedTargets(step:AgentTaskStep):AgentTaskTarget[] {
    const saved=record(step.data)?step.data.referencedTargets:undefined;
    if(saved!==undefined&&!Array.isArray(saved))throw agentTaskFailure('AGENT_TASK_STORAGE_UNAVAILABLE');
    const references=Array.isArray(saved)?saved:[];
    // Old accepted steps predate reference metadata. Read their exact admitted
    // arguments too; restoring a run must not reopen the nested-reference gap.
    const explicit=step.toolCall?agentTaskExplicitTargets(step.toolCall.name,step.toolCall.arguments,journal.run(step.runId).projectId).map(target=>({...target,revision:0})):[];
    return [...dispatchTargets(step),...references.map(value=>{const parsed=agentTaskTargetSchema.safeParse(value);if(!parsed.success)throw agentTaskFailure('AGENT_TASK_STORAGE_UNAVAILABLE');return parsed.data;}),...explicit];
  }
  const approvalDigest=(step:AgentTaskStep):string=>createHash('sha256').update(JSON.stringify({call:step.toolCall,targets:step.targets,tier:step.tier,...(record(step.data)&&Array.isArray(step.data.dispatchApprovalTargets)?{dispatchTargets:step.data.dispatchApprovalTargets}:{}),...(record(step.data)&&step.data.rulesProposal!==undefined?{rulesProposal:step.data.rulesProposal}:{}),...(record(step.data)&&step.data.projectFileImport!==undefined?{projectFileImport:step.data.projectFileImport}:{})})).digest('hex');
  const approved=(step:AgentTaskStep):boolean=>record(step.data)&&step.data.approvalDigest===approvalDigest(step);
  /** The user's answer becomes the question's tool result. It is input, never an approval. */
  function answerResult(step:AgentTaskStep,request:{choices:number[];text?:string}):AgentTaskJson{
    const parsed=agentTaskQuestionSchema.safeParse(step.toolCall?.arguments);if(!parsed.success)throw agentTaskFailure('AGENT_TASK_INVALID');
    const question=parsed.data,choices=[...request.choices].sort((a,b)=>a-b),text=request.text?.trim();
    if(choices.some(index=>index>=question.options.length)||!question.multiple&&choices.length>1)throw agentTaskFailure('AGENT_TASK_INVALID');
    // Free text alone answers any question; beside a choice it needs "other".
    if(text!==undefined&&choices.length>0&&!question.allowOther||!choices.length&&!text)throw agentTaskFailure('AGENT_TASK_INVALID');
    return {answer:{choices,...(text?{text}:{})},selected:choices.map(index=>question.options[index]!.label),...(text?{text}:{})};
  }
  const skippedMessage=(run:AgentTaskRun):string=>skippedInstructions[taskResponseLocale(run.context)];
  function assertNotSkipped(run:AgentTaskRun,targets:AgentTaskTarget[]):void {
    if(targets.some(target=>run.skippedTargets?.some(item=>item.target.kind===target.kind&&item.target.id===target.id)))throw agentTaskFailure('AGENT_TASK_TARGET_SKIPPED');
  }
  function rememberConflict(runId:string,stepId:string,targets:AgentTaskTarget[]):void {
    const current=journal.step(stepId),known=[...(current.targets??[])];
    for(const target of targets)if(!known.some(item=>item.kind===target.kind&&item.id===target.id))known.push(target);
    journal.updateStep(runId,stepId,{targets:known,data:{...(record(current.data)?current.data:{}),conflictTargets:json(targets)}});
  }
  function unresolvedConflict(step:AgentTaskStep):boolean {
    return step.kind==='tool'&&record(step.data)&&Array.isArray(step.data.conflictTargets)&&step.data.conflictTargets.length>0&&(step.status==='intent'||step.status==='awaiting_approval'||step.status==='completed'&&step.data.backgroundInvalidated===true);
  }
  /** X4: later calls of the same response never run after a handed-back call.
   * The saved flag answers them through the invalidated-batch path. */
  function invalidateRestOfBatch(runId:string,step:AgentTaskStep,reason?:'user_rejected'|'user_answered'):void {
    const sourceId=record(step.data)&&typeof step.data.sourceModelStepId==='string'?step.data.sourceModelStepId:undefined;if(!sourceId)return;
    const source=journal.step(sourceId);if(source.runId!==runId||source.kind!=='model')return;
    const calls=modelOutput(source.result).toolCalls,position=calls.findIndex(item=>item.id===step.toolCall?.id);
    if(position>=0&&position<calls.length-1&&(!record(source.data)||source.data.toolsInvalidated!==true))journal.updateStep(runId,source.id,{data:{...(record(source.data)?source.data:{}),toolsInvalidated:true,...(reason?{toolsInvalidatedReason:reason}:{})}});
  }
  function pauseForRepeatedToolFailure(runId:string,step:AgentTaskStep):boolean {
    // Return the current batch's non-submission receipts to Mio before stopping
    // a later attempt for which a service is still unavailable.
    if(isGenerationServiceDenial(step))return false;
    if(!repeatedToolFailure(journal.snapshot(runId).steps,journal.safetyWindow(runId).afterPosition,step.id))return false;
    const sourceId=record(step.data)&&typeof step.data.sourceModelStepId==='string'?step.data.sourceModelStepId:undefined;
    if(!sourceId)throw agentTaskFailure('AGENT_TASK_STORAGE_UNAVAILABLE');
    const apply=()=>{
      const source=journal.step(sourceId);
      if(source.runId!==runId||source.kind!=='model')throw agentTaskFailure('AGENT_TASK_STORAGE_UNAVAILABLE');
      journal.updateStep(runId,sourceId,{data:{...(record(source.data)?source.data:{}),toolsInvalidated:true,toolsInvalidatedReason:'repeated_tool_failure'}});
      pause(runId,'repeated_tool_failure');
    };
    if(store.db.isTransaction)apply();else store.tx(apply);
    return true;
  }
  /** X4: a foreground step that meets a conflict before it runs is rejected
   * with the saved values of its conflicting targets, and the run continues.
   * The step, its result and the batch flag commit in one transaction. */
  function handBackConflict(runId:string,stepId:string,failure:string,targets:AgentTaskTarget[]):AgentTaskStep {
    const apply=():AgentTaskStep=>{
      if(journal.step(stepId).status==='dispatch_started')journal.dispatchPrevented(runId,stepId,'intent');
      const run=journal.run(runId),current=journal.step(stepId),known=[...(current.targets??[])];
      for(const target of targets)if(!known.some(item=>item.kind===target.kind&&item.id===target.id))known.push(target);
      const errorCode=failure==='AGENT_TASK_TARGET_CLAIMED'?'TARGET_EDITING':'TARGET_CHANGED';
      // Read directly from the domain tables, not through the journal proxy.
      const values=toolset().currentTargets(run.projectId,targets);
      const message=(errorCode==='TARGET_CHANGED'&&!values.length?conflictProjectRereadInstructions:conflictInstructions[errorCode])[taskResponseLocale(run.context)];
      const saved=journal.updateStep(runId,stepId,{status:'rejected',targets:known,data:{...(record(current.data)?current.data:{}),conflictTargets:json(targets)},result:{error:{code:errorCode,message,current:values,...(targets.length>values.length?{omittedTargets:targets.length-values.length}:{})}},error:{code:errorCode,message}});
      invalidateRestOfBatch(runId,saved);return saved;
    };
    try{return store.db.isTransaction?apply():store.tx(apply);}catch(error){if(storageError(error))failStorage(error);throw error;}
  }
  /** X4 follow-up: a stale revision the domain rejected as not applied is
   * returned to Mio like a rejected parameter set, and the run continues. */
  function rejectStaleRevision(runId:string,stepId:string):AgentTaskStep {
    const apply=():AgentTaskStep=>{
      if(journal.step(stepId).status==='dispatch_started')journal.dispatchPrevented(runId,stepId,'intent');
      const message=revisionConflictInstructions[taskResponseLocale(journal.run(runId).context)];
      return journal.updateStep(runId,stepId,{status:'rejected',result:{error:{code:'REVISION_CONFLICT',message}},error:{code:'REVISION_CONFLICT',message}});
    };
    try{return store.db.isTransaction?apply():store.tx(apply);}catch(error){if(storageError(error))failStorage(error);throw error;}
  }
  const removeGate=readOnly?()=>{}:setAgentTaskEffectGate(store.db,binding=>{
    mutable();const step=journal.step(binding.stepId);
    if(record(step.data)&&step.data.backgroundDenied===true)throw agentTaskFailure('AGENT_TASK_STOPPED');
    const run=fence(binding.runId,true);
    if(run.projectId!==binding.projectId||step.runId!==run.id)throw agentTaskFailure('AGENT_TASK_NOT_FOUND');
    assertNotSkipped(run,referencedTargets(step));
    try{journal.assertTargets(run.projectId,dispatchTargets(step));}catch(error){
      const failure=code(error);if(failure==='AGENT_TASK_TARGET_CHANGED'||failure==='AGENT_TASK_TARGET_CLAIMED'){
        const invalidate=()=>{rememberConflict(run.id,step.id,journal.conflictingTargets(run.projectId,dispatchTargets(step)));const current=journal.step(step.id);journal.updateStep(run.id,step.id,{data:{...(record(current.data)?current.data:{}),backgroundInvalidated:true}});pause(run.id,failure==='AGENT_TASK_TARGET_CHANGED'?'conflict':'editing');};
        if(store.db.isTransaction)invalidate();else store.tx(invalidate);
      }throw error;
    }
    if(step.tier&&(journal.effectiveModes(run.projectId,run.conversationId)[step.tier]==='confirm'||record(step.data)&&step.data.backgroundApprovalRequired===true)&&!approved(step)){
      const requestApproval=()=>{const current=journal.step(step.id);if(!record(current.data)||current.data.backgroundApprovalRequired!==true)journal.updateStep(run.id,step.id,{data:{...(record(current.data)?current.data:{}),backgroundApprovalRequired:true,dispatchApprovalTargets:json(dispatchTargets(current))}});if(journal.run(run.id).status!=='awaiting_approval')changeStatus(run.id,'awaiting_approval');};
      if(store.db.isTransaction)requestApproval();else store.tx(requestApproval);
      throw agentTaskFailure('AGENT_TASK_APPROVAL_REQUIRED');
    }
  });
  function toolFence(runId:string,stepId:string,prepared:PreparedAgentTaskTool):void {
    const run=fence(runId),step=journal.step(stepId);
    if(step.runId!==run.id||step.status==='rejected'||step.status==='denied')throw agentTaskFailure('AGENT_TASK_PAUSED');
    assertNotSkipped(run,prepared.referencedTargets??prepared.targets);
    if((prepared.forceApproval||journal.effectiveModes(run.projectId,run.conversationId)[prepared.risk]==='confirm'||step.status==='awaiting_approval')&&!approved(step))throw agentTaskFailure('AGENT_TASK_APPROVAL_REQUIRED');
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
  function invalidLoaderInputMessage(run:AgentTaskRun,source:AgentTaskStep,input:AgentTaskJson):string {
    const locale=taskResponseLocale(run.context),fallback=invalidLoaderInputMessages[locale],protocol=configuration(run).protocol;
    if(sourceTaskModelToolLoadMode(protocol,source.request)!=='names'||!record(input)||!Array.isArray(input.names))return fallback;
    // Invalid arguments may bypass the declared enum/array bounds. Echo only a
    // bounded list of ordinary wire identifiers, never arbitrary model text.
    if(input.names.length>128||input.names.some(name=>typeof name!=='string'||!/^[-A-Za-z0-9_]{1,64}$/u.test(name)))return fallback;
    const visible=new Set(sourceTaskModelToolNames(protocol,source.request)),catalog=new Set(toolset().list().map(tool=>tool.name));
    const profile='native',core:string[]=[],unknown:string[]=[],unlisted:string[]=[];
    for(const name of new Set(input.names as string[])){
      if(!catalog.has(name))unknown.push(name);
      else if(visible.has(name)&&agentTaskToolGroupForName(name,profile)==='core')core.push(name);
      else if(!sourceTaskModelToolLoadInputAllowed(protocol,source.request,{names:[name]}))unlisted.push(name);
    }
    const labels=invalidLoaderNameMessages[locale];
    return [fallback,...([{names:core,label:labels.core},{names:unknown,label:labels.unknown},{names:unlisted,label:labels.unlisted}]
      .filter(item=>item.names.length).map(item=>`${item.label} ${item.names.map(name=>JSON.stringify(name)).join(', ')}.`))].join(' ');
  }
  function recordGenerationServiceDenial(run:AgentTaskRun,step:AgentTaskStep,source:AgentTaskStep,reason:typeof GENERATION_SERVICE_UNAVAILABLE|'IMAGE_SETTINGS_SELECTION_REQUIRED'):AgentTaskStep {
    const firstDenial=journal.snapshot(run.id).steps.find(item=>item.toolCall?.name===step.toolCall?.name&&item.status==='rejected'&&isGenerationServiceDenial(item));
    const sameBatch=firstDenial&&record(firstDenial.data)&&firstDenial.data.sourceModelStepId===source.id;
    const unavailable=reason===GENERATION_SERVICE_UNAVAILABLE,locale=taskResponseLocale(run.context);
    const error={code:reason,message:(unavailable?generationServiceUnavailableMessages:imageServiceSelectionMessages)[locale]};
    return store.tx(()=>{
      if(step.status==='dispatch_started')journal.dispatchPrevented(run.id,step.id,'intent');
      return journal.updateStep(run.id,step.id,{status:!firstDenial||sameBatch?'rejected':'failed',error,result:{error:{...error,mutationOutcome:'not_applied',submitted:false,generationCharged:false,...(unavailable?{settingsAction:'configure_generation_services'}:{})}}});
    });
  }
  async function performTool(runId:string,source:AgentTaskStep,call:TaskModelOutput['toolCalls'][number],signal:AbortSignal,observed?:AgentTaskStep):Promise<AgentTaskStep|null>{
    let step=observed;
    if(step&&settledTool(step))return step;
    if(step&&['unknown','dispatch_started'].includes(step.status))throw agentTaskFailure('AGENT_TASK_UNKNOWN_RESULT');
    // A background approval can interrupt an awaited tool while this executor
    // still holds its earlier source snapshot. Read the saved batch decision
    // without reconstructing the frozen request or revision baseline.
    source=journal.step(source.id);
    if(source.runId!==runId||source.kind!=='model')throw agentTaskFailure('AGENT_TASK_STORAGE_UNAVAILABLE');
    const run=fence(runId);
    // User decisions invalidate the entire suffix before visibility checks or
    // target preparation. The durable source flag survives a restart; earlier
    // terminal steps were returned above and never execute again.
    const invalidatedReason=record(source.data)&&source.data.toolsInvalidated===true?source.data.toolsInvalidatedReason:undefined;
    if(invalidatedReason==='repeated_tool_failure'){
      const result={error:{code:'AGENT_TASK_REPEATED_TOOL_FAILURE',message:loopInvalidatedBatchInstructions[taskResponseLocale(run.context)]}};
      return step?journal.updateStep(runId,step.id,{status:'rejected',result}):{...source,kind:'tool',status:'rejected',toolCall:call,result};
    }
    if(invalidatedReason==='user_rejected'||invalidatedReason==='user_answered'){
      const message=userInvalidatedBatchInstructions[invalidatedReason][taskResponseLocale(run.context)];
      const result={error:{code:invalidatedReason==='user_rejected'?'USER_REJECTED':'USER_ANSWERED',message}};
      return step?journal.updateStep(runId,step.id,{status:'rejected',result}):{...source,kind:'tool',status:'rejected',toolCall:call,result};
    }
    if(isProjectStore(store)&&!run.diagnostic&&call.name==='mioon_project_notes_set'){
      if(!step)step=journal.beginStep(runId,{kind:'tool',toolCall:call,data:{sourceModelStepId:source.id,...repairStepData(source)}});
      const message='This project-notes tool is retired. No operation was applied. Replan using the project rules tool; changing AGENTS.md always requires a new explicit user approval.';
      const rejected=journal.updateStep(runId,step.id,{status:'rejected',result:{error:{code:'TOOL_RETIRED',message}},error:{code:'TOOL_RETIRED',message}});
      invalidateRestOfBatch(runId,rejected);return rejected;
    }
    if(!run.diagnostic){
      let visible:string[];try{visible=sourceTaskModelToolNames(configuration(run).protocol,source.request);}catch(error){if(storageError(error))failStorage(error);throw error;}
      if(!visible.includes(call.name)){
        const group=agentTaskToolGroupForName(call.name,'native');if(group===undefined)throw agentTaskFailure('AGENT_CHAT_TOOLS_UNSUPPORTED');
        if(!step){const explanation=taskToolExplanation(modelOutput(source.result),call.id);step=journal.beginStep(runId,{kind:'tool',toolCall:call,...(explanation?{text:explanation}:{}),data:{sourceModelStepId:source.id,...repairStepData(source)}});}
        const message=unloadedToolMessages[taskResponseLocale(run.context)];
        return journal.updateStep(runId,step.id,{status:'rejected',result:{error:{code:'TOOL_NOT_LOADED',message,group}},error:{code:'TOOL_NOT_LOADED',message}});
      }
    }
    if(!step&&record(source.data)&&source.data.toolsInvalidated===true){
      const current=run;let kept=false;
      try{const pending=toolset().prepare({projectId:current.projectId,operation:call.name,input:call.arguments,...(call.name===AGENT_TASK_TOOLS_LOAD_NAME?{toolLoadMode:sourceTaskModelToolLoadMode(configuration(current).protocol,source.request)}:{}),beforeTargetRead:target=>assertNotSkipped(current,[{...target,revision:0}])});kept=(pending.referencedTargets??pending.targets).some(target=>current.skippedTargets?.some(item=>item.target.kind===target.kind&&item.target.id===target.id));}
      catch(error){if(storageError(error))throw error;if(code(error)==='AGENT_TASK_TARGET_SKIPPED')kept=true;}
      return {...source,kind:'tool',status:kept?'denied':'rejected',toolCall:call,result:{error:{code:kept?'TARGET_SKIPPED':'TARGET_CHANGED',message:kept?skippedMessage(current):invalidatedBatchInstructions[taskResponseLocale(current.context)]}}};
    }
    let prepared:PreparedAgentTaskTool|undefined,conflicts:AgentTaskTarget[]=[];
    // Diagnostic selection is a host-only restriction, never an authority. In
    // particular, catalog probes describe write tools without executing them.
    if(run.diagnostic&&(run.diagnostic.profile!=='read_only'||!runTools(run).some(tool=>tool.name===call.name)))throw agentTaskFailure('AGENT_TASK_DIAGNOSTIC_TOOL_FORBIDDEN');
    if(!step){const explanation=taskToolExplanation(modelOutput(source.result),call.id);step=journal.beginStep(runId,{kind:'tool',toolCall:call,...(explanation?{text:explanation}:{}),data:{sourceModelStepId:source.id,...repairStepData(source)}});}
    try {
      const protocol=configuration(run).protocol;
      if(call.name===AGENT_TASK_TOOLS_LOAD_NAME&&!sourceTaskModelToolLoadInputAllowed(protocol,source.request,call.arguments)){
        const message=invalidLoaderInputMessage(run,source,call.arguments);
        return journal.updateStep(runId,step.id,{status:'rejected',result:{error:{code:'VALIDATION_ERROR',message}},error:{code:'VALIDATION_ERROR',message}});
      }
      prepared=toolset().prepare({projectId:run.projectId,operation:call.name,input:call.arguments,...(call.name===AGENT_TASK_TOOLS_LOAD_NAME?{toolLoadMode:sourceTaskModelToolLoadMode(protocol,source.request)}:{}),beforeTargetRead:target=>assertNotSkipped(journal.run(runId),[{...target,revision:0}])});
      if(prepared.operation===MIO_PROJECT_FILE_IMPORT_OPERATION){
        const initial=prepared,stepId=step.id;
        // Preparing the frozen source is read-only and precedes approval. The
        // full execution toolFence would require that approval too early.
        const beforePrepare=()=>{signal.throwIfAborted();const current=fence(runId);assertNotSkipped(current,initial.referencedTargets??initial.targets);journal.assertTargets(current.projectId,initial.targets);};
        prepared=await toolset().prepareProjectFileImport(initial,{requestId:stepId,signal,beforeEffect:beforePrepare,
          ...(record(step.data)&&step.data.projectFileImport!==undefined?{retained:step.data.projectFileImport}:{})});
        beforePrepare();step=journal.step(stepId);
      }
      if(['asset.importSelected','lut.importSelected'].includes(prepared.operation)&&(!Array.isArray(run.attachments)||!run.attachments.includes(String(prepared.input.handle))))throw agentTaskFailure('AGENT_TASK_CONSENT_REQUIRED');
      assertNotSkipped(journal.run(runId),prepared.referencedTargets??prepared.targets);
      if(step.targets&&!isDeepStrictEqual(step.targets,prepared.targets)){
        conflicts=[...step.targets.filter(target=>!prepared!.targets.some(item=>item.kind===target.kind&&item.id===target.id&&item.revision===target.revision)),...prepared.targets.filter(target=>!step!.targets!.some(item=>item.kind===target.kind&&item.id===target.id))];
        throw agentTaskFailure('AGENT_TASK_TARGET_CHANGED');
      }
      step=journal.updateStep(runId,step.id,{targets:prepared.targets,tier:prepared.risk,data:{...(record(step.data)?step.data:{}),referencedTargets:json(prepared.referencedTargets??prepared.targets),...(prepared.proposal===undefined?{}:{rulesProposal:prepared.proposal}),...(prepared.projectFileImport===undefined?{}:{projectFileImport:json(prepared.projectFileImport)})}});
      conflicts=modelConflictingTargets(prepared,source);if(conflicts.length)throw agentTaskFailure('AGENT_TASK_TARGET_CHANGED');
      journal.assertTargets(run.projectId,prepared.targets);
      const serviceIssue=toolset().generationServiceIssue(prepared);
      if(serviceIssue)return recordGenerationServiceDenial(run,step,source,serviceIssue);
      // C3: a question waits for the user's answer; nothing is dispatched.
      if(prepared.operation===AGENT_TASK_ASK_OPERATION){journal.updateStep(runId,step.id,{status:'awaiting_answer'});changeStatus(runId,'awaiting_answer');return null;}
      // Loosening the modes later never approves a confirmation already shown.
      if((prepared.forceApproval||journal.effectiveModes(run.projectId,run.conversationId)[prepared.risk]==='confirm'||step.status==='awaiting_approval')&&!approved(step)){
        journal.updateStep(runId,step.id,{status:'awaiting_approval',...(prepared.proposal===undefined?{}:{result:{rulesProposal:prepared.proposal}})});changeStatus(runId,'awaiting_approval');return null;
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
      if(storageError(error))failStorage(error);
      // X4: a step that meets a conflict before it runs is handed back, not paused.
      // This includes a pending approval re-entered after a pause or restart.
      // A partly committed (completed) step keeps the conflict pause below.
      if((failure==='AGENT_TASK_TARGET_CHANGED'||failure==='AGENT_TASK_TARGET_CLAIMED')&&['intent','awaiting_approval','dispatch_started'].includes(journal.step(step.id).status))
        return handBackConflict(runId,step.id,failure,conflicts.length?conflicts:journal.conflictingTargets(run.projectId,journal.step(step.id).targets??prepared?.targets??[]));
      if(['AGENT_TASK_TARGET_CHANGED','AGENT_TASK_TARGET_CLAIMED','AGENT_TASK_APPROVAL_REQUIRED','AGENT_TASK_PAUSED','AGENT_TASK_ABORTED','ABORT_ERR'].includes(failure)){
        if(journal.step(step.id).status==='dispatch_started')journal.dispatchPrevented(runId,step.id,failure==='AGENT_TASK_APPROVAL_REQUIRED'?'awaiting_approval':'intent');
        if(failure==='AGENT_TASK_TARGET_CHANGED'||failure==='AGENT_TASK_TARGET_CLAIMED')rememberConflict(runId,step.id,conflicts.length?conflicts:journal.conflictingTargets(run.projectId,journal.step(step.id).targets??prepared?.targets??[]));
        if(failure==='AGENT_TASK_APPROVAL_REQUIRED'){journal.updateStep(runId,step.id,{status:'awaiting_approval'});changeStatus(runId,'awaiting_approval');}
        else pause(runId,failure==='AGENT_TASK_TARGET_CLAIMED'?'editing':failure==='AGENT_TASK_TARGET_CHANGED'?'conflict':'user');return null;
      }
      if(['AGENT_TASK_UNKNOWN_RESULT','MIO_RULES_WRITE_UNCERTAIN','MIO_RULES_PENDING'].includes(failure)){
        const current=journal.step(step.id);if(current.status==='awaiting_approval')journal.updateStep(runId,step.id,{status:'intent'});
        if(current.status==='intent'||current.status==='awaiting_approval')journal.markDispatch(runId,step.id);
        journal.updateStep(runId,step.id,{status:'unknown'});pause(runId,'unknown_outcome');return null;
      }
      if(failure==='AGENT_TASK_TARGET_SKIPPED'){
        if(journal.step(step.id).status==='dispatch_started')journal.dispatchPrevented(runId,step.id,'intent');
        return journal.updateStep(runId,step.id,{status:'denied',result:{error:{code:'TARGET_SKIPPED',message:skippedMessage(journal.run(runId))}},error:{code:'TARGET_SKIPPED',message:skippedMessage(journal.run(runId))}});
      }
      if(failure==='AGENT_TASK_CONSENT_REQUIRED'||failure==='AGENT_TASK_STORAGE_UNAVAILABLE')throw error;
      const current=journal.step(step.id);if(current.status==='completed')throw error;
      if((prepared?.operation==='generation.submit'||prepared?.operation==='image.generate')&&(failure===GENERATION_SERVICE_UNAVAILABLE||failure==='IMAGE_SETTINGS_SELECTION_REQUIRED')&&error instanceof AppError&&record(error.details)&&error.details.mutationOutcome==='not_applied')
        return recordGenerationServiceDenial(run,current,source,failure);
      if(current.status==='intent'&&failure==='VALIDATION_ERROR'){
        let feedback;
        try{feedback=await toolset().parameterFeedback({projectId:run.projectId,operation:call.name,input:call.arguments,beforeTargetRead:target=>assertNotSkipped(journal.run(runId),[{...target,revision:0}])});}
        catch(feedbackError){if(storageError(feedbackError))throw feedbackError;}
        if(feedback){
          fence(runId);
          // Only a locally rejected, undispatched parameter set may return to
          // the model for correction. The next request still needs its own
          // normal validation and paid approval; unknown results never enter here.
          return journal.updateStep(runId,step.id,{status:'rejected',result:{error:{code:failure,...feedback}},error:{code:failure,message:feedback.message}});
        }
      }
      if(failure==='REVISION_CONFLICT'&&(current.status==='intent'||current.status==='dispatch_started')&&record(error)&&record(error.details)&&error.details.mutationOutcome==='not_applied')return rejectStaleRevision(runId,step.id);
      const uncertain=current.status==='dispatch_started'&&(!record(error)||!record(error.details)||error.details.mutationOutcome!=='not_applied');
      if(uncertain&&prepared?.risk!=='read_only'){
        journal.updateStep(runId,step.id,{status:'unknown',error:{code:failure,message:'工具结果未知，请核对原请求。'}});pause(runId,'unknown_outcome');return null;
      }
      return journal.updateStep(runId,step.id,{status:'failed',result:{error:{code:failure,message:'工具未完成，请检查参数或可用性。'}},error:{code:failure,message:'工具未完成，请检查参数或可用性。'}});
    }
  }
  async function checkExecutionWitness(runId:string,signal:AbortSignal):Promise<void>{
    const frozen=fence(runId);if(!frozen.settingsBinding)throw agentTaskFailure('AGENT_TASK_SETTINGS_CHANGED');
    const settings=await new Promise<unknown>((resolve,reject)=>{
      const abort=()=>reject(agentTaskFailure('AGENT_TASK_PAUSED'));signal.addEventListener('abort',abort,{once:true});
      Promise.resolve().then(()=>{fence(runId);return agentSettings.get({selfPort:selfPort(),signal});}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
    const active=sanitizeAgentSettingsResult(settings).execution;fence(runId);
    if(!active||active.revision!==frozen.settingsRevision||!isDeepStrictEqual(active.binding,frozen.settingsBinding)||!isDeepStrictEqual(active.configuration,configuration(frozen)))throw agentSettingsError('AGENT_SETTINGS_CONFLICT');
  }
  async function acquireForModel(runId:string,signal:AbortSignal):Promise<string|null>{
    const run=fence(runId);if(!run.settingsBinding)throw agentTaskFailure('AGENT_TASK_SETTINGS_CHANGED');
    const expected={expectedRevision:run.settingsRevision??0,configuration:configuration(run),binding:run.settingsBinding};
    const credential=await new Promise<Awaited<ReturnType<AgentSettingsService[typeof AGENT_CREDENTIAL_ACQUIRE]>>>((resolve,reject)=>{
      const abort=()=>reject(agentTaskFailure('AGENT_TASK_PAUSED'));signal.addEventListener('abort',abort,{once:true});
      Promise.resolve().then(()=>{fence(runId);return agentSettings[AGENT_CREDENTIAL_ACQUIRE](expected,{selfPort:selfPort(),signal});}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
    const acquired=sanitizeAgentCredentialResult(credential,expected);fence(runId);return acquired.apiKey;
  }
  async function execute(runId:string,signal:AbortSignal):Promise<void>{
    let inflight:string|undefined;
    try {
      let run=fence(runId);const config=configuration(run);
      // Recovery can execute retained tools without another model request. Check
      // the frozen selected-entry witness before that path, without decoding a key.
      await checkExecutionWitness(runId,signal);
      modelRequests:for(;;){
        run=fence(runId);const snapshot=journal.snapshot(runId),context=cloneTaskBaseContext(run.context,run.text),fragments:TaskModelContextFragment[]=[];
        const observedToolIds=toolStepIds(snapshot.steps);
        let repairSource=snapshot.steps.find(step=>step.kind==='model'&&goalRepairMessage(step)!==undefined)?.id;
        let resumeModel:AgentTaskStep|undefined,pendingModel:AgentTaskStep|undefined;
        for(const model of snapshot.steps.filter(item=>item.kind==='model')){
          fragments.push({kind:'notes',notes:run.notes??[],modelStepId:model.id});
          if(model.status==='failed'&&record(model.result)&&model.result.discarded===true){fragments.push({kind:'discarded',modelStepId:model.id});continue;}
          if(model.status==='failed'&&record(model.data)&&model.data.retryRequested===true)continue;
          if(model.status==='intent'){pendingModel=model;break;}
          if(model.status!=='completed')throw agentTaskFailure('AGENT_TASK_UNKNOWN_RESULT');
          const output=modelOutput(model.result);
          if(!output.toolCalls.length||run.diagnostic?.profile==='catalog'){
            const repairMessage=goalRepairMessage(model);
            if(repairMessage){retainModelContinuation(config.protocol,fragments,{kind:'continuation',modelStepId:model.id,output,results:[],repairMessage,...(record(model.data)&&model.data.replanRequested===true?{replan:true}:{})});resumeModel=model;continue;}
            if(record(model.data)&&model.data.replanRequested===true){retainModelContinuation(config.protocol,fragments,{kind:'continuation',modelStepId:model.id,output,results:[],replan:true});continue;}
            if(record(model.data)&&model.data.noteContinuationRequested===true||(journal.run(runId).notes??[]).some(note=>note.modelStepId===undefined)){
              if(!record(model.data)||model.data.noteContinuationRequested!==true)journal.updateStep(runId,model.id,{data:{...(record(model.data)?model.data:{}),noteContinuationRequested:true}});
              const diagnosticResults=output.toolCalls.map(call=>({callId:call.id,result:{error:{code:'DIAGNOSTIC_NOT_EXECUTED'}}}));
              retainModelContinuation(config.protocol,fragments,{kind:'continuation',modelStepId:model.id,output,results:diagnosticResults});resumeModel=model;continue;
            }
            if(!run.diagnostic&&!repairSource&&journal.safetyWindow(runId).remaining>0&&latestAgentTaskGoals(snapshot.steps)?.conditions.length){
              const checks=await readAgentTaskChecks(store,snapshot),gaps=checks.requirements?.filter(item=>item.status==='failed')??[];
              const current=fence(runId);
              // A note accepted while checks were reading has priority over a
              // host repair. Rebuild normally so it binds to the next intent.
              if((current.notes??[]).some(note=>note.modelStepId===undefined))continue modelRequests;
              if(gaps.length&&journal.safetyWindow(runId).remaining>0){
                const message=`${goalRepairInstructions[taskResponseLocale(run.context)]}\n${JSON.stringify({kind:'mio.goal.repair',requirements:gaps})}`;
                // Persist the exact observation before constructing an intent.
                // Recovery replays it, rather than rechecking a changed project.
                const saved=journal.updateStep(runId,model.id,{data:{...(record(model.data)?model.data:{}),goalRepair:{version:1,message}}});
                repairSource=model.id;
                retainModelContinuation(config.protocol,fragments,{kind:'continuation',modelStepId:model.id,output,results:[],repairMessage:message});resumeModel=saved;continue;
              }
            }
            changeStatus(runId,'completed');return;
          }
          const results:{callId:string;result:AgentTaskJson}[]=[];
          for(const call of output.toolCalls){
            // The executor owns new tool rows. Read the exact receipt, and
            // yield even for a completed tool so a queued note can be observed
            // before we decide whether the saved final reply ends the run.
            const identity=toolStepIdentity(model.id,call.id),savedId=observedToolIds.get(identity);
            const saved=savedId===undefined?undefined:journal.step(savedId);
            if(saved&&(saved.runId!==runId||saved.toolCall?.id!==call.id||!record(saved.data)||saved.data.sourceModelStepId!==model.id))throw agentTaskFailure('AGENT_TASK_STORAGE_UNAVAILABLE');
            const replaying=saved!==undefined&&settledTool(saved);
            const finished=await (replaying?saved:performTool(runId,model,call,signal,saved));if(!finished)return;
            if(!replaying&&finished.id!==model.id)observedToolIds.set(identity,finished.id);
            // An earlier receipt will be replayed while assembling every new
            // request. Only a newly settled real tool can cross this boundary.
            if(!replaying&&finished.id!==model.id&&unsuccessfulTool(finished)&&pauseForRepeatedToolFailure(runId,finished))return;
            if(finished.status==='failed'&&(!record(model.data)||model.data.toolsInvalidated!==true)){
              changeStatus(runId,'failed',finished.error?.code??'AGENT_TASK_FAILED');return;
            }
            results.push({callId:call.id,result:retainedToolContextResult(finished)});
            // X4: a handed-back call saved the batch flag. Read it back so the
            // rest of this batch is answered as not executed; replay already has it.
            if(finished.status==='rejected'&&CONFLICT_REREAD_CODES.has(finished.error?.code??'')&&call!==output.toolCalls.at(-1)&&(!record(model.data)||model.data.toolsInvalidated!==true)){
              const saved=journal.step(model.id);if(record(saved.data)&&saved.data.toolsInvalidated===true)continue modelRequests;
            }
          }
          retainModelContinuation(config.protocol,fragments,{kind:'continuation',modelStepId:model.id,output,results});resumeModel=model;
        }
        run=fence(runId);
        if(pendingModel&&journal.prepareModelStep)pendingModel=journal.prepareModelStep(runId,pendingModel.id);
        const originalBody=pendingModel&&record(pendingModel.request)&&typeof pendingModel.request.body==='string'?pendingModel.request.body:undefined;
        let body:string,model:AgentTaskStep;
        if(pendingModel&&originalBody!==undefined){
          // A durable intent owns its exact request and already-bound notes.
          // A known assembler upgrade above may replace only a provably unsent
          // intent. Every other replay retains its original frozen input.
          body=originalBody;model=pendingModel;
        }else{
          // Capture once: the hint and the immutable request must describe the
          // very same revision boundary, including across later replay.
          const current=journal.snapshot(runId);
          if(!pendingModel){
            const {afterPosition,remaining}=journal.safetyWindow(runId);
            // All calls from a completed model reply have been handled. A pause
            // here leaves the current tool batch and any approval receipts intact.
            if(noToolProgress(current.steps,afterPosition)){pause(runId,'no_tool_progress');return;}
            if(!remaining){pause(runId,'safety_limit');return;}
          }
          const baseline=journal.revisionSnapshot(run.projectId),modelTools=runTools(run);
          // History is budgeted against this request's own tool catalog.
          const budget=taskModelHistoryBudget(config,modelTools,taskResponseLocale(context),selfPort(),{toolLoading:!run.diagnostic});
          const {history,tools:definitions,pendingNotes}=assembleModelInput({context,text:run.text,notes:pendingModel?[]:run.notes,tools:modelTools,replay:{protocol:config.protocol,fragments,steps:current.steps,changes:current.changes,skippedTargets:run.skippedTargets,baseline,runId,diagnostic:!!run.diagnostic,budget}});
          body=buildTaskModelRequest(config,history,definitions,selfPort(),{toolLoading:!run.diagnostic});
          model=pendingModel??journal.beginModelStep(runId,{request:{body,history},data:{baseline:json(baseline),assemblyModelStepIds:[...new Set(fragments.flatMap(fragment=>fragment.modelStepId?[fragment.modelStepId]:[]))],...(resumeModel?{previousModelStepId:resumeModel.id}:{}),...(repairSource?{goalRepairSourceModelStepId:repairSource}:{})}},pendingNotes.map(note=>note.requestId));
        }
        const knownTools=run.diagnostic?undefined:toolset().list();
        // Each model request reacquires only its frozen selected service. A
        // save to another service cannot invalidate it or deliver another key.
        const key=await acquireForModel(runId,signal);
        journal.markDispatch(runId,model.id);inflight=model.id;let output:TaskModelOutput|null=null,pending='',lastFlush=Date.now();
        let flushTimer:ReturnType<typeof setTimeout>|undefined,flushFailed=false,timerError:unknown,rejectRead:((error:unknown)=>void)|undefined;
        const clearFlushTimer=()=>{if(flushTimer!==undefined){clearTimeout(flushTimer);flushTimer=undefined;}};
        const flush=()=>{
          clearFlushTimer();
          if(pending&&!closed&&!storageFaulted&&journal.run(runId).status!=='stopped'){
            try{journal.appendText(runId,model.id,pending);}catch(error){flushFailed=true;throw error;}
            pending='';lastFlush=Date.now();
          }
        };
        const scheduleFlush=()=>{
          if(!pending||flushTimer!==undefined||signal.aborted)return;
          flushTimer=setTimeout(()=>{
            try{flush();}catch(error){
              // A timer must not throw outside the executor or leave a stalled
              // gateway running after an audit write failed. Fence immediately
              // and deliver the failure to its one pending iterator read.
              try{failStorage(error);}catch(failure){timerError=failure;rejectRead?.(failure);}
            }
          },Math.max(0,250-(Date.now()-lastFlush)));
        };
        signal.addEventListener('abort',clearFlushTimer,{once:true});
        const stream=gateway({configuration:config,body,apiKey:key,signal,selfPort:selfPort(),knownTools,beforeSubmit:()=>{fence(runId);}});
        let streamEnded=false;
        try{
          for(;;){
            if(timerError)throw timerError;
            let next:IteratorResult<TaskModelItem,void>;
            try{next=await new Promise<IteratorResult<TaskModelItem,void>>((resolve,reject)=>{rejectRead=reject;stream.next().then(resolve,reject);});}
            finally{rejectRead=undefined;}
            if(timerError)throw timerError;
            if(next.done){streamEnded=true;if(closed||journal.run(runId).status==='stopped')return;break;}
            const item=next.value;
            if(closed||journal.run(runId).status==='stopped')return;
            if(output)throw agentTaskFailure('AGENT_TASK_FAILED');
            if(item.type==='delta'){pending+=item.text;if(Buffer.byteLength(pending)>8*1024||Date.now()-lastFlush>=250)flush();else scheduleFlush();}
            else output=item.output;
          }
          flush();if(!output)throw agentTaskFailure('AGENT_TASK_UNKNOWN_RESULT');
        }catch(error){
          // Preserve received text before recording a failed/unknown exchange.
          // Failed writes are never retried; stop and close discard the buffer.
          if(!flushFailed)flush();
          throw error;
        }finally{
          clearFlushTimer();signal.removeEventListener('abort',clearFlushTimer);
          if(!streamEnded)await stream.return();
        }
        // Only normalized counters join the private completion receipt. Missing
        // or malformed passive usage never changes model/tool recovery rules.
        const {usage:reportedUsage,...completion}=output,usage=taskModelUsage(reportedUsage);
        journal.completeStep(runId,model.id,{result:json({...completion,...(usage?{usage}:{})})});inflight=undefined;
        if(journal.run(runId).status!=='running')return;
      }
    }catch(error){
      if(closed)return;
      const prevented=wasTaskSubmissionPrevented(error);
      if(prevented)for(const step of journal.snapshot(runId).steps)if(step.kind==='model'&&step.status==='dispatch_started')journal.dispatchPrevented(runId,step.id,'intent');
      const run=journal.run(runId);if(terminal(run)||run.status==='paused'||run.status==='awaiting_approval'||run.status==='awaiting_answer')return;
      const failure=code(error);
      if(failure==='AGENT_TASK_BUDGET_EXHAUSTED'){pause(runId,'safety_limit');return;}
      const message=agentChatHttpStatus(error)===undefined&&agentChatStreamReason(error)===undefined?agentTaskFailure(failure).message:safeAgentChatError(error).message;
      const diagnostic=agentChatDiagnostic(error),stepError={code:failure,message,...(diagnostic?{diagnostic}:{})};
      if(prevented)for(const step of journal.snapshot(runId).steps)if(step.kind==='model'&&step.status==='intent')journal.updateStep(runId,step.id,{status:'failed',error:stepError});
      if(inflight&&!prevented&&observedModelFailures.has(failure)&&journal.step(inflight).status==='dispatch_started')journal.updateStep(runId,inflight,{status:'failed',error:stepError});
      for(const step of journal.snapshot(runId).steps)if(step.status==='dispatch_started')journal.updateStep(runId,step.id,{status:'unknown',error:{code:failure,message}});
      if(failure==='AGENT_TASK_UNKNOWN_RESULT'){pause(runId,'unknown_outcome');return;}
      changeStatus(runId,'failed',failure);journal.appendEvent(runId,'error',{code:failure,message});
    }
  }
  function launch(runId:string):void {
    const current=active.get(runId);if(current){current.restartRequested=true;return;}if(closed||storageFaulted)return;
    const controller=new AbortController(),entry:Active={controller,promise:Promise.resolve(),restartRequested:false};active.set(runId,entry);
    const failClosed=(error:unknown)=>{
      // Even recording the failure may fail. Keep the durable intent for explicit
      // recovery and fence this runtime; never retry an executor automatically.
      storageFaulted=true;if(storageError(error))storageFailureCode=storageFailure(error);for(const task of active.values())task.controller.abort();
    };
    entry.promise=execute(runId,controller.signal).catch(failClosed).finally(()=>{
      if(active.get(runId)===entry)active.delete(runId);
      const run=journal.run(runId);
      if(onDiagnosticCompleted&&run.diagnostic?.profile==='text'&&terminal(run)){
        const config=record(run.configuration)?run.configuration:{};
        const diagnostic=run.status==='failed'&&run.pauseReason==='AGENT_CHAT_HTTP_ERROR'?diagnosticHttpFailure(journal.snapshot(runId)):undefined;
        onDiagnosticCompleted(agentDiagnosticSummarySchema.parse({completedAt:run.updatedAt,status:run.status,
          protocol:config.protocol,model:config.model,...(run.settingsBinding&&run.settingsRevision!==undefined?{settingsBinding:run.settingsBinding,settingsRevision:run.settingsRevision}:{}),errorCode:run.status==='failed'&&typeof run.pauseReason==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/u.test(run.pauseReason)?run.pauseReason:null,...(diagnostic?{diagnostic}:{})}));
      }
      if(entry.restartRequested&&!closed&&!storageFaulted&&run.status==='running')queueMicrotask(()=>launch(runId));
    }).catch(failClosed);
  }
  async function snapshot(projectId:string){checkOpen();if(!store.get('projects',projectId))throw agentTaskFailure('AGENT_TASK_NOT_FOUND');const settings=sanitizeAgentSettingsResult(await agentSettings.get({selfPort:selfPort()}));return {version:2 as const,instanceId,projectId,readOnly,runs:(hasTables?journal.list(projectId,{excludeDiagnostics:true}):[]).map(run=>{const {context,...summary}=run;return summary;}),policy:hasTables?journal.policy():structuredClone(DEFAULT_AGENT_TASK_POLICY),settings,authorization:authorizations.snapshot(settings.execution?.configuration??null)};}
  async function send(projectId:string,input:unknown):Promise<AgentTaskSnapshot>{
    mutable();if(!record(input)||Object.keys(input).some(key=>!['requestId','text','expectedSettingsRevision','expectedRevision','locale','uploads','diagnostic','conversationId','policy'].includes(key))||typeof input.requestId!=='string'||input.requestId.length<8||input.requestId.length>200||typeof input.text!=='string'||!input.text.trim()||Buffer.byteLength(input.text)>32*1024||!Number.isSafeInteger(input.expectedSettingsRevision)||input.uploads!==undefined&&(!Array.isArray(input.uploads)||input.uploads.length>20||input.uploads.some(id=>typeof id!=='string'||!/^[-a-f0-9]{36}$/u.test(id))))throw agentTaskFailure('AGENT_TASK_INVALID');
    const parsedLocale=agentTaskLocaleSchema.safeParse(input.locale===undefined?DEFAULT_AGENT_TASK_LOCALE:input.locale);if(!parsedLocale.success)throw agentTaskFailure('AGENT_TASK_INVALID');const locale=parsedLocale.data;
    const parsedDiagnostic=input.diagnostic===undefined?undefined:agentTaskDiagnosticSchema.safeParse(input.diagnostic);
    if(parsedDiagnostic&&!parsedDiagnostic.success)throw agentTaskFailure('AGENT_TASK_INVALID');
    const diagnostic=parsedDiagnostic?.success?parsedDiagnostic.data:undefined;
    if(diagnostic?.toolNames?.some(name=>!selectTaskModelTools(toolset().diagnosticList(),{profile:'catalog'}).some(tool=>tool.name===name)))throw agentTaskFailure('AGENT_TASK_INVALID');
    const uploads=(input.uploads??[]) as string[];
    if(input.conversationId!==undefined&&(typeof input.conversationId!=='string'||!/^[-a-f0-9]{36}$/iu.test(input.conversationId)||diagnostic))throw agentTaskFailure('AGENT_TASK_INVALID');
    const conversationId=input.conversationId as string|undefined;
    // A new conversation may start with its own modes (C1); later changes use the conversation policy.
    if(input.policy!==undefined&&conversationId!==undefined)throw agentTaskFailure('AGENT_TASK_INVALID',{policyOnContinuation:true});
    const parsedPolicy=input.policy===undefined?undefined:agentTaskSendSchema.shape.policy.safeParse(input.policy);
    if(parsedPolicy&&(!parsedPolicy.success||!parsedPolicy.data||diagnostic||!journal.conversationPolicies()))throw agentTaskFailure('AGENT_TASK_INVALID');
    const conversationModes=parsedPolicy?.success?parsedPolicy.data?.modes:undefined;
    const previous=journal.lookupRequest(projectId,input.requestId);if(previous){if(previous.run.text!==input.text||taskResponseLocale(previous.run.context)!==locale||!isDeepStrictEqual(previous.run.attachments??[],uploads)||!isDeepStrictEqual(previous.run.diagnostic,diagnostic))throw agentTaskFailure('AGENT_TASK_REQUEST_CONFLICT');if(journal.requestConversationId(previous.run.id)!==conversationId)throw agentTaskFailure('AGENT_TASK_REQUEST_CONFLICT');if(!journal.sentConversationModesMatch(input.requestId,conversationModes))throw agentTaskFailure('AGENT_TASK_REQUEST_CONFLICT');return safeSnapshot(previous,store);}
    const settings=sanitizeAgentSettingsResult(await agentSettings.get({selfPort:selfPort()})),execution=settings.execution;if(!execution)throw agentTaskFailure('AGENT_TASK_NOT_CONFIGURED');if(execution.revision!==input.expectedSettingsRevision)throw agentTaskFailure('AGENT_TASK_SETTINGS_CHANGED');
    const dummy={configuration:json(execution.configuration)} as AgentTaskRun;authorize(dummy);
    if(conversationModes?.paid==='direct'&&journal.policy().modes.paid!=='direct'&&parsedPolicy?.success&&parsedPolicy.data?.acknowledgePaid!==true)throw agentTaskFailure('AGENT_TASK_APPROVAL_REQUIRED');
    const historyRuns=diagnostic||!conversationId?undefined:journal.modelContextRuns(projectId,conversationId).reverse();
    const projectOverview=diagnostic?undefined:collectTaskProjectOverview(store,projectId),projectNotes=undefined;
    const rulesSnapshot=diagnostic?undefined:captureRules();
    const attachments=uploads.map(id=>{const row=store.db.prepare(`SELECT id,name,mimeType FROM ${mioTable(store.db,'imports')} WHERE id=? AND projectId=?`).get(id,projectId);if(!row)throw agentTaskFailure('AGENT_TASK_NOT_FOUND');return {handle:String(row.id),name:String(row.name),mimeType:String(row.mimeType)};});
    // Earlier runs are trimmed to the first request's budget: core tools plus
    // attachment imports. That request still validates the profile and reports
    // its error, so an unsupported configuration keeps the byte budget here.
    let budget:Readonly<TaskHistoryBudget>|undefined;
    if(historyRuns?.length)try{budget=taskModelHistoryBudget(configuration(dummy),selectTaskModelTools(toolset().list(),undefined,{steps:[],attachments:uploads}),locale,selfPort(),{toolLoading:true});}catch(error){if(!code(error).startsWith('AGENT_CHAT_'))throw error;}
    const {context}=assembleRunContext({locale,text:input.text,historyRuns,projectOverview,projectNotes,rulesSnapshot,attachments,budget});
    if(active.size>=4)throw agentTaskFailure('AGENT_TASK_BUSY');
    mutable();
    const created=journal.create({projectId,...(conversationId?{conversationId}:{}),...(conversationModes?{conversationModes}:{}),requestId:input.requestId,text:input.text,configuration:json(execution.configuration),settingsRevision:execution.revision,settingsBinding:execution.binding,context,attachments:uploads,...(rulesSnapshot?{rulesSnapshot}:{}),...(diagnostic?{diagnostic}:{})});launch(created.run.id);return safeSnapshot(journal.snapshot(created.run.id),store);
  }
  function assertNoteCapacity(runId:string):void {
    const snapshot=journal.snapshot(runId),run=snapshot.run,latest=snapshot.steps.filter(step=>step.kind==='model').at(-1);
    const context=cloneTaskBaseContext(run.context,run.text),fragments:TaskModelContextFragment[]=[];
    // Replay only retained observations, never prepare or execute a tool. The
    // saved request may already be compressed and must not be used as a raw
    // base followed by the same rounds for a second time.
    for(const model of snapshot.steps.filter(step=>step.kind==='model')){
      fragments.push({kind:'notes',notes:run.notes??[],modelStepId:model.id});
      if(model.status==='failed'&&record(model.result)&&model.result.discarded===true){fragments.push({kind:'discarded',modelStepId:model.id});continue;}
      if(model.status==='failed'&&record(model.data)&&model.data.retryRequested===true)continue;
      if(model.status==='completed'){
        const output=modelOutput(model.result),results=output.toolCalls.map(call=>{
          const tool=snapshot.steps.find(step=>step.toolCall?.id===call.id&&record(step.data)&&step.data.sourceModelStepId===model.id);
          return {callId:call.id,result:run.diagnostic?.profile==='catalog'?{error:{code:'DIAGNOSTIC_NOT_EXECUTED'}}:retainedToolContextResult(tool)};
        });
        const replan=(!output.toolCalls.length||run.diagnostic?.profile==='catalog')&&record(model.data)&&model.data.replanRequested===true;
        const repairMessage=goalRepairMessage(model);
        fragments.push({kind:'continuation',modelStepId:model.id,output,results,...(replan?{replan:true}:{}),...(repairMessage?{repairMessage}:{})});
      }else if(model===latest&&model.status==='dispatch_started'&&model.text){
        // Count only already-persisted deltas. Unknown output may be explicitly
        // discarded later, and buffered deltas are not saved observations.
        fragments.push({kind:'partial',modelStepId:model.id,text:model.text});
      }
    }
    // Reject known overflow in the control transaction, before acknowledging
    // the note. Future model/tool output remains subject to the original caps.
    // This is only a capacity probe: it never submits or changes a saved intent.
    try{const config=configuration(run),baseline=journal.revisionSnapshot(run.projectId),modelTools=runTools(run),budget=taskModelHistoryBudget(config,modelTools,taskResponseLocale(context),selfPort(),{toolLoading:!run.diagnostic}),{history,tools:definitions}=assembleModelInput({context,text:run.text,notes:run.notes,tools:modelTools,replay:{protocol:config.protocol,fragments,steps:snapshot.steps,changes:snapshot.changes,skippedTargets:run.skippedTargets,baseline,runId,diagnostic:!!run.diagnostic,budget}});buildTaskModelRequest(config,history,definitions,selfPort(),{toolLoading:!run.diagnostic});}
    catch(error){if(code(error)==='AGENT_CHAT_LIMIT')throw agentTaskFailure('AGENT_TASK_NOTE_CAPACITY');throw error;}
  }
  async function action(projectId:string,runId:string,input:unknown):Promise<AgentTaskSnapshot>{
    mutable();const parsed=agentTaskControlSchema.safeParse(record(input)?{...input,runId}:input);if(!parsed.success)throw agentTaskFailure('AGENT_TASK_INVALID');const request=parsed.data;
    const undo=request.action==='undo_change'||request.action==='undo_all';
    const old=journal.lookupControl(request.requestId);if(old){owned(projectId,runId);if(undo)journal.beginControl(request);else journal.performControl(request,()=>null);return safeSnapshot(journal.snapshot(runId),store);}
    let run=owned(projectId,runId);const cancelBackgroundSteps:string[]=[];try{if(run.revision!==request.expectedRevision)throw agentTaskFailure('AGENT_TASK_REVISION_CONFLICT');
    let projectImportResolution:ProjectAssetImportLookup|undefined;
    if(request.action==='resolve_unknown'&&request.stepId){
      const original=journal.step(request.stepId);
      if(original.runId===runId&&original.status==='unknown'&&original.toolCall?.name===MIO_PROJECT_FILE_IMPORT_TOOL){
        const retained=record(original.data)?original.data.projectFileImport:undefined;
        const prepared=toolset().prepare({projectId,operation:original.toolCall.name,input:original.toolCall.arguments});
        const checkLookup=()=>{mutable();const current=owned(projectId,runId),step=journal.step(original.id);if(current.revision!==request.expectedRevision)throw agentTaskFailure('AGENT_TASK_REVISION_CONFLICT');if(step.runId!==runId||step.status!=='unknown'||step.toolCall?.name!==MIO_PROJECT_FILE_IMPORT_TOOL)throw agentTaskFailure('AGENT_TASK_STATE_CONFLICT');};
        // Read the bounded original-key receipt outside the control's write
        // transaction. Its synchronous snapshot fence is checked inside it.
        projectImportResolution=await toolset().lookupProjectFileImport(prepared,{requestId:original.id,retained,beforeEffect:checkLookup});
        checkLookup();
      }
    }
    if(request.action==='undo_change'||request.action==='undo_all'){
      if(!terminal(run))throw agentTaskFailure('AGENT_TASK_PAUSED');
      const changes=journal.snapshot(runId).changes,undoChangeIds=request.action==='undo_all'&&request.undoChangeIds!==undefined?new Set(request.undoChangeIds):undefined;
      if(undoChangeIds){const planned=projectAgentTaskUndo(store,projectId,changes),currentIds=changes.filter(change=>planned.get(change.id)?.undoDisposition==='undo').map(change=>change.id);if(currentIds.length!==undoChangeIds.size||currentIds.some(id=>!undoChangeIds.has(id)))throw agentTaskFailure('AGENT_TASK_TARGET_CHANGED');}
      journal.beginControl(request);
      const candidates=changes.reverse();
      const chain=new Map<string,AgentTaskTarget>(),retainedChangeIds:string[]=[];let importControlCompleted=false;
      try{for(const change of candidates){
        if(change.status==='reverted'){for(const target of change.revertedTargets??[])chain.set(`${target.kind}:${target.id}`,target);continue;}
        if(change.status!=='applied'||!change.reversible||request.action==='undo_change'&&change.id!==request.changeId)continue;
        // A saved compensation revision only bridges adjacent AI changes. It
        // must not jump across an intervening external edit, including ABA.
        const expectedTargets=change.targets.map(target=>{const next=chain.get(`${target.kind}:${target.id}`);return next&&next.revisionBefore===(target.revisionAfter??target.revision)?next:target;});
        if(request.action==='undo_change'&&change.targets.some(target=>target.revisionAfter!==undefined&&journal.targetRevision(projectId,target.kind,target.id)>target.revisionAfter))throw agentTaskFailure('AGENT_TASK_TARGET_CHANGED');
        if(request.action==='undo_all'&&store.tx(()=>{if(!agentTaskChangeWasModified(store,change,expectedTargets))return false;journal.markChangeSupersededInside(change.id);return true;})){retainedChangeIds.push(change.id);continue;}
        const reverted=toolset().undo(change,{requestId:`${request.requestId}:${change.id}`,expectedTargets,beforeEffect:()=>{owned(projectId,runId);journal.assertTargets(projectId,expectedTargets);},beforeCompensation:()=>{if(undoChangeIds&&!undoChangeIds.has(change.id))throw agentTaskFailure('AGENT_TASK_TARGET_CHANGED');},recordInside:()=>{
          journal.markChangeRevertedInside(change.id);
          if(change.operation===MIO_PROJECT_FILE_IMPORT_OPERATION){
            const revertedIds=journal.snapshot(runId).changes.filter(item=>item.status==='reverted').map(item=>item.id);
            journal.finishControl(request.requestId,{state:request.action==='undo_change'?'completed':'pending',revertedIds});
            importControlCompleted=request.action==='undo_change';
          }
        },retainInside:(_change,reason)=>{journal.markChangeRetainedInside(change.id,reason);}});
        if(reverted.retained){retainedChangeIds.push(change.id);continue;}
        for(const target of reverted.targets)chain.set(`${target.kind}:${target.id}`,target);
      }}catch(error){journal.finishControl(request.requestId,{state:'blocked',code:code(error),...(retainedChangeIds.length?{retainedChangeIds}:{})});throw error;}
      run=journal.run(runId);if(request.action==='undo_all'&&!journal.snapshot(runId).changes.some(change=>change.reversible&&change.status==='applied'))changeStatus(runId,'reverted');
      if(!importControlCompleted)journal.finishControl(request.requestId,{state:'completed',...(retainedChangeIds.length?{retainedChangeIds}:{})});
    }else journal.performControl(request,():AgentTaskJson=>{
      run=owned(projectId,runId);if(run.revision!==request.expectedRevision)throw agentTaskFailure('AGENT_TASK_REVISION_CONFLICT');
      if(request.action==='note'){journal.appendNoteInside(runId,request.requestId,request.text);assertNoteCapacity(runId);return {state:'completed',noteRequestId:request.requestId};}
      if(request.action==='answer'){
        if(run.status!=='awaiting_answer')throw agentTaskFailure('AGENT_TASK_STATE_CONFLICT');
        const step=journal.step(request.stepId);
        if(step.runId!==runId||step.kind!=='tool'||step.status!=='awaiting_answer'||step.toolCall?.name!==AGENT_TASK_ASK_TOOL)throw agentTaskFailure('AGENT_TASK_INVALID');
        journal.updateStep(runId,step.id,{status:'completed',result:answerResult(step,request)});
        invalidateRestOfBatch(runId,journal.step(step.id),'user_answered');
        journal.resume(runId,journal.run(runId).revision);
        return {state:'completed',stepId:step.id};
      }
      if(request.action==='retry'){
        const steps=journal.snapshot(runId).steps,last=steps.at(-1);
        if(steps.some(step=>step.status==='unknown'||step.status==='dispatch_started'))throw agentTaskFailure('AGENT_TASK_UNKNOWN_RESULT');
        if(run.status!=='failed'||!last||last.status!=='failed'||request.stepId!==undefined&&request.stepId!==last.id)throw agentTaskFailure('AGENT_TASK_STATE_CONFLICT');
        if(store.db.prepare(`SELECT 1 FROM ${mioTable(store.db,'runs')} WHERE projectId=? AND id<>? AND status IN ('accepted','running','paused','awaiting_approval','awaiting_answer','interrupted') LIMIT 1`).get(projectId,runId))throw agentTaskFailure('AGENT_TASK_BUSY');
        authorize(run);
        if(last.kind==='model')journal.updateStep(runId,last.id,{data:{...(record(last.data)?last.data:{}),retryRequested:true}});
        else {
          const sourceId=record(last.data)&&typeof last.data.sourceModelStepId==='string'?last.data.sourceModelStepId:undefined,source=sourceId?steps.find(step=>step.id===sourceId):undefined;
          if(!source||source.kind!=='model'||source.status!=='completed')throw agentTaskFailure('AGENT_TASK_STATE_CONFLICT');
          journal.updateStep(runId,source.id,{data:{...(record(source.data)?source.data:{}),toolsInvalidated:true}});
        }
        changeStatus(runId,'running');
        if(!journal.safetyWindow(runId).remaining)changeStatus(runId,'paused','safety_limit');
        return {state:'completed',stepId:last.id};
      }
      if(request.action==='pause'){if(run.status==='running'||run.status==='awaiting_approval'||run.status==='completed'&&journal.hasPendingBackground(runId))changeStatus(runId,'paused','user');}
      else if(request.action==='stop'){if(!terminal(run)||run.status==='completed'&&journal.hasPendingBackground(runId)){changeStatus(runId,'stopped');for(const step of journal.snapshot(runId).steps)if(step.status==='dispatch_started')journal.updateStep(runId,step.id,{status:'unknown'});}}
      else if(request.action==='approve'||request.action==='deny'){
        if(run.status!=='awaiting_approval'||!request.stepId)throw agentTaskFailure('AGENT_TASK_INVALID');const step=journal.step(request.stepId),background=step.status==='completed'&&record(step.data)&&step.data.backgroundApprovalRequired===true;if(step.runId!==runId||step.status!=='awaiting_approval'&&!background)throw agentTaskFailure('AGENT_TASK_INVALID');
        if(request.action==='approve'){authorize(run);assertNotSkipped(run,referencedTargets(step));journal.assertTargets(projectId,background?dispatchTargets(step):step.targets??[]);}
        if(background){journal.updateStep(runId,step.id,{data:{...(record(step.data)?step.data:{}),backgroundApprovalRequired:false,...(request.action==='approve'?{approvalDigest:approvalDigest(step)}:{backgroundDenied:true})}});if(request.action==='deny')cancelBackgroundSteps.push(step.id);}
        else journal.updateStep(runId,step.id,{status:request.action==='approve'?'intent':'rejected',data:{...(record(step.data)?step.data:{}),...(request.action==='approve'?{approvalDigest:approvalDigest(step),...(isProjectStore(store)&&step.toolCall?.name==='mioon_project_rules_set'?{rulesApprovalReceiptId:request.requestId}:{})}:{})},...(request.action==='deny'?{result:{error:{code:'USER_REJECTED',message:'用户拒绝了此操作。'}}}:{})});
        if(request.action==='deny'){
          const denied=journal.step(step.id);
          if(!background&&pauseForRepeatedToolFailure(runId,denied))return null;
          invalidateRestOfBatch(runId,denied,'user_rejected');
        }
        journal.resume(runId,journal.run(runId).revision);
        if(request.action==='approve'&&isProjectStore(store)&&step.toolCall?.name==='mioon_project_rules_set')return {state:'completed',approvedRules:{stepId:step.id,proposalDigest:approvalDigest(step)}};
      }else if(request.action==='resolve_unknown'){
        if(!request.stepId)throw agentTaskFailure('AGENT_TASK_INVALID');const step=journal.step(request.stepId);if(step.runId!==runId||step.status!=='unknown')throw agentTaskFailure('AGENT_TASK_UNKNOWN_RESULT');
        if(step.toolCall?.name===MIO_PROJECT_FILE_IMPORT_TOOL){
          const proof=projectImportResolution;if(!proof)throw agentTaskFailure('AGENT_TASK_UNKNOWN_RESULT');proof.assertCurrent();
          if(proof.outcome==='applied'&&request.resolution==='accept_result'){
            const result=mioProjectFileImportResultSchema.parse({registration:'reused',assetId:proof.asset.id,asset:proof.asset});
            // A receipt proves the original import, not a missing creation
            // Change. Recovery therefore adds no compensation authority.
            journal.updateStep(runId,step.id,{status:'completed',result:json(result)});
          }else if(proof.outcome==='not_applied'&&request.resolution==='discard'||proof.outcome==='retired'&&request.resolution==='accept_result'){
            const retired=proof.outcome==='retired';
            journal.updateStep(runId,step.id,{status:'failed',result:{error:{code:retired?'PROJECT_IMPORT_RETIRED':'UNKNOWN_NOT_APPLIED',message:retired?'原请求登记已移除，保留历史，不重建。':'已核对原请求，登记未提交；请重新规划，不重放旧参数。'}},error:{code:retired?'PROJECT_IMPORT_RETIRED':'UNKNOWN_NOT_APPLIED',message:'已核对原请求的登记状态。'}});
            const sourceId=record(step.data)&&typeof step.data.sourceModelStepId==='string'?step.data.sourceModelStepId:undefined;
            if(sourceId){const source=journal.step(sourceId);if(source.runId!==runId||source.kind!=='model'||source.status!=='completed')throw agentTaskFailure('AGENT_TASK_STATE_CONFLICT');journal.updateStep(runId,source.id,{data:{...(record(source.data)?source.data:{}),toolsInvalidated:true}});}
          }else throw agentTaskFailure('AGENT_TASK_UNKNOWN_RESULT');
        }else if(step.kind==='model'&&request.resolution==='discard')journal.updateStep(runId,step.id,{status:'failed',result:{discarded:true},error:{code:'USER_DISCARDED_UNKNOWN',message:'用户已将未知模型请求标记为失败。'}});
        else if(step.toolCall?.name==='mioon_task_wait'&&request.resolution==='accept_result'){
          const prepared=toolset().prepare({projectId,operation:step.toolCall.name,input:step.toolCall.arguments}),result=toolset().recoverWait(prepared);
          if(result===null)throw agentTaskFailure('AGENT_TASK_UNKNOWN_RESULT');journal.updateStep(runId,step.id,{status:'completed',result});
        }else if(step.toolCall&&request.resolution==='discard'){
          if(step.toolCall.name===AGENT_TASK_TOOLS_LOAD_NAME){
            const sourceId=record(step.data)&&typeof step.data.sourceModelStepId==='string'?step.data.sourceModelStepId:undefined;
            if(!sourceId)throw agentTaskFailure('AGENT_TASK_STORAGE_UNAVAILABLE');
            const source=journal.step(sourceId);if(source.runId!==runId||source.kind!=='model')throw agentTaskFailure('AGENT_TASK_STORAGE_UNAVAILABLE');
            const toolLoadMode=sourceTaskModelToolLoadMode(configuration(run).protocol,source.request);
            toolset().prepare({projectId,operation:step.toolCall.name,input:step.toolCall.arguments,toolLoadMode});
          }
          const proof=toolset().recoverLocalUnknown({projectId,runId,stepId:step.id,requestId:step.id});
          if(!proof)throw agentTaskFailure('AGENT_TASK_UNKNOWN_RESULT');journal.updateStep(runId,step.id,{status:'failed',result:{...proof,error:{code:'UNKNOWN_NOT_APPLIED',message:'已核对原子回执，旧步骤未提交。请重新读取当前状态后规划，不要重放旧参数。'}}});
          const sourceId=record(step.data)&&typeof step.data.sourceModelStepId==='string'?step.data.sourceModelStepId:undefined;
          if(sourceId){const source=journal.step(sourceId);if(source.runId!==runId||source.kind!=='model'||source.status!=='completed')throw agentTaskFailure('AGENT_TASK_STATE_CONFLICT');journal.updateStep(runId,source.id,{data:{...(record(source.data)?source.data:{}),toolsInvalidated:true}});}
        }else throw agentTaskFailure('AGENT_TASK_UNKNOWN_RESULT');
      }else if(request.action==='resume'||request.action==='skip'){
        // A question is answered, not resumed past.
        if(run.status==='awaiting_answer')throw agentTaskFailure('AGENT_TASK_STATE_CONFLICT');
        authorize(run);const conflict=run.pauseReason==='conflict'||run.pauseReason==='editing';
        // Recovery acknowledges interruption, never the old conflict's plan.
        // Older runtimes saved only restart, so also inspect unresolved evidence.
        if(request.action==='resume'&&run.status==='interrupted'&&(conflict||journal.snapshot(runId).steps.some(unresolvedConflict))){
          journal.resume(runId,run.revision);
          changeStatus(runId,'paused',conflict?run.pauseReason:'conflict');return null;
        }
        if(request.action==='resume'&&conflict)throw agentTaskFailure('AGENT_TASK_SKIP_REQUIRED');
        if(request.action==='skip'&&(run.status!=='paused'||!conflict))throw agentTaskFailure('AGENT_TASK_INVALID');
        let skipped:AgentTaskTarget[]=[];
        if(request.action==='skip'){
          const steps=journal.snapshot(runId).steps;
          const actual=steps.filter(unresolvedConflict).flatMap(step=>(step.data as unknown as {conflictTargets:AgentTaskTarget[]}).conflictTargets.map(target=>({stepId:step.id,target})));
          skipped=journal.skipTargetsInside(runId,actual).map(item=>item.target);
          const background=steps.filter(step=>step.status==='completed'&&record(step.data)&&(step.data.backgroundApprovalRequired===true||step.data.backgroundInvalidated===true)&&referencedTargets(step).some(target=>skipped.some(item=>item.kind===target.kind&&item.id===target.id)));
          for(const step of background){journal.updateStep(runId,step.id,{data:{...(record(step.data)?step.data:{}),backgroundApprovalRequired:false,backgroundInvalidated:false,backgroundDenied:true}});cancelBackgroundSteps.push(step.id);}
          const final=steps.filter(step=>step.kind==='model'&&step.status==='completed').at(-1);
          if(background.length&&final&&!modelOutput(final.result).toolCalls.length)journal.updateStep(runId,final.id,{data:{...(record(final.data)?final.data:{}),replanRequested:true}});
          for(const model of steps.filter(step=>step.kind==='model'&&step.status==='completed')){
            const calls=modelOutput(model.result).toolCalls;
            if(calls.some(call=>!steps.some(step=>step.toolCall?.id===call.id&&record(step.data)&&step.data.sourceModelStepId===model.id&&['completed','denied','rejected','failed'].includes(step.status))))journal.updateStep(runId,model.id,{data:{...(record(model.data)?model.data:{}),toolsInvalidated:true}});
          }
          for(const step of steps)if(step.kind!=='model'&&(step.status==='intent'||step.status==='awaiting_approval')){
            const kept=referencedTargets(step).some(target=>journal.run(runId).skippedTargets?.some(item=>item.target.kind===target.kind&&item.target.id===target.id));
            journal.updateStep(runId,step.id,{status:kept?'denied':'rejected',result:{error:{code:kept?'TARGET_SKIPPED':'TARGET_CHANGED',message:kept?skippedMessage(run):'目标已变化，请按当前保存状态重新规划。'}}});
          }
        }
        journal.resume(runId,journal.run(runId).revision,{resetSafetyWindow:request.action==='resume'});
        if(request.action==='skip')return {state:'completed',skippedTargets:skipped.map(target=>({kind:target.kind,id:target.id}))};
      }
      return null;
    });
    if(request.action==='stop')active.get(runId)?.controller.abort();
    if(request.action==='stop'||request.action==='undo_all'&&journal.run(runId).status==='reverted')await stopAgentTaskJobs(store.db,runId);
    for(const stepId of cancelBackgroundSteps)await stopAgentTaskJobs(store.db,runId,stepId);
    if((request.action==='resume'||request.action==='skip'||request.action==='approve'||request.action==='deny')&&journal.run(runId).status==='running')resumeAgentTaskJobs(store.db,runId);
    if(journal.run(runId).status==='running')launch(runId);return safeSnapshot(journal.snapshot(runId),store);
    }catch(error){
      const failure=code(error);let handedBack=false;
      if(failure==='AGENT_TASK_TARGET_CHANGED'||failure==='AGENT_TASK_TARGET_CLAIMED'){
        const step=request.action==='approve'&&request.stepId?journal.step(request.stepId):undefined;
        // X4: a foreground approval that meets a conflict is still rejected. The
        // step is handed back and the run continues; a new plan needs a new approval.
        if(step?.status==='awaiting_approval'&&journal.run(runId).status==='awaiting_approval'){
          const handBack=()=>{handBackConflict(runId,step.id,failure,journal.conflictingTargets(projectId,dispatchTargets(step)));journal.resume(runId,journal.run(runId).revision);};
          if(store.db.isTransaction)handBack();else store.tx(handBack);handedBack=true;
        }else{
          // Background approvals may pause; an undo of a terminal run stays terminal.
          if(step)rememberConflict(runId,step.id,journal.conflictingTargets(projectId,dispatchTargets(step)));
          if(!undo)pause(runId,failure==='AGENT_TASK_TARGET_CHANGED'?'conflict':'editing');
        }
      }
      if(storageError(error))failStorage(error);
      journal.rejectControl(request,failure);
      // Background work this run held for approval is queued again with the run.
      if(handedBack&&journal.run(runId).status==='running'){resumeAgentTaskJobs(store.db,runId);launch(runId);}
      if(handedBack)throw agentTaskFailure(failure,{handedBack:true});
      if(undo&&(failure==='AGENT_TASK_TARGET_CHANGED'||failure==='AGENT_TASK_TARGET_CLAIMED'))throw agentTaskFailure(failure,{undo:true});
      throw error;
    }
  }
  return {journal,instanceId,readOnly,snapshot,send,action,
    isBusy:()=>active.size>0||hasTables&&!!store.db.prepare(`SELECT 1 FROM ${mioTable(store.db,'runs')} WHERE status IN ('accepted','running') LIMIT 1`).get(),
    history:(projectId:string,cursor?:string)=>{checkOpen();if(!store.get('projects',projectId))throw agentTaskFailure('AGENT_TASK_NOT_FOUND');return hasTables?journal.history(projectId,{cursor}):{conversations:[],nextCursor:null};},
    /** The settings page's connection test: the newest text diagnostic in the workspace, without its text or reply. */
    latestConnectionTest:()=>{checkOpen();const found=hasTables?journal.latestDiagnostic('text'):null;if(!found)return {test:null};
      const {run}=found,configuration=record(run.configuration)?run.configuration:{},text=(value:unknown):string=>typeof value==='string'?value:'';
      const failureCode=run.status==='failed'&&typeof run.pauseReason==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/u.test(run.pauseReason)?run.pauseReason:undefined;
      const diagnostic=diagnosticHttpFailure(found);
      return {test:{runId:run.id,projectId:run.projectId,status:run.status,createdAt:run.createdAt,updatedAt:run.updatedAt,protocol:text(configuration.protocol),baseUrl:text(configuration.baseUrl),model:text(configuration.model),...(failureCode?{failureCode}:{}),...(diagnostic?{diagnostic}:{})}};},
    conversation:(projectId:string,conversationId:string,cursor?:string)=>{checkOpen();if(!hasTables||!store.get('projects',projectId))throw agentTaskFailure('AGENT_TASK_NOT_FOUND');const page=journal.conversation(projectId,conversationId,{cursor});return {...page,runs:page.runs.map(run=>{const {context,...summary}=run;return summary;})};},
    timelineRevision:(projectId:string)=>{checkOpen();const row=store.db.prepare("SELECT json_extract(data,'$.revision') AS revision FROM timelines WHERE projectId=?").get(projectId);return row?Number(row.revision):null;},
    get:(projectId:string,id:string)=>{owned(projectId,id);return safeSnapshot(journal.snapshot(id),store);},
    usage:(projectId:string,id:string)=>{owned(projectId,id);return readMioRunUsage(store,id);},
    checks:(projectId:string,id:string,{preflight=false,signal}:{preflight?:boolean;signal?:AbortSignal}={})=>{owned(projectId,id);return readAgentTaskChecks(store,journal.snapshot(id),{preflight:checksPreflight,includePreflight:preflight,signal});},
    lookup:(projectId:string,requestId:string)=>{checkOpen();const found=hasTables?journal.lookupRequest(projectId,requestId):null;return {found:!!found,...(found?{snapshot:safeSnapshot(found,store)}:{})};},
    lookupAction:(projectId:string,id:string,requestId:string)=>{owned(projectId,id);const found=journal.lookupControl(requestId);if(found&&found.runId!==id)throw agentTaskFailure('AGENT_TASK_NOT_FOUND');return {found:!!found,...(found?{snapshot:safeSnapshot(journal.snapshot(id),store),receipt:found}:{})};},
    lookupImport:(projectId:string,requestId:string)=>{mutable();const row=store.db.prepare(`SELECT id,name,mimeType,status FROM ${mioTable(store.db,'imports')} WHERE projectId=? AND requestId=?`).get(projectId,requestId);return row?{id:String(row.id),name:String(row.name),mimeType:String(row.mimeType),status:String(row.status)}:null;},
    events:(projectId:string,id:string,after=0)=>{owned(projectId,id);return {sequence:journal.eventSequence(id,after),snapshot:safeSnapshot(journal.snapshot(id),store)};},
    conversationPolicy:(projectId:string,conversationId:string)=>{checkOpen();if(!hasTables)throw agentTaskFailure('AGENT_TASK_NOT_FOUND');if(!store.get('projects',projectId))throw agentTaskFailure('AGENT_TASK_NOT_FOUND');return journal.conversationPolicy(projectId,conversationId);},
    setConversationPolicy:(projectId:string,conversationId:string,input:unknown)=>{
      mutable();const parsed=agentTaskConversationPolicySetSchema.safeParse(input);if(!parsed.success||!/^[-a-f0-9]{36}$/iu.test(conversationId))throw agentTaskFailure('AGENT_TASK_INVALID');
      if(!store.get('projects',projectId))throw agentTaskFailure('AGENT_TASK_NOT_FOUND');
      return journal.setConversationPolicy(projectId,conversationId,parsed.data);
    },
    policy:()=>hasTables?journal.policy():structuredClone(DEFAULT_AGENT_TASK_POLICY),lookupPolicy:(id:string)=>({found:hasTables&&!!journal.lookupPolicy(id),...(hasTables&&journal.lookupPolicy(id)?{policy:journal.lookupPolicy(id)}:{})}),updatePolicy:(input:unknown)=>{
      mutable();if(!record(input)||Object.keys(input).some(key=>!['requestId','expectedRevision','revision','stepLimit','modes','acknowledgePaid'].includes(key))||typeof input.requestId!=='string'||input.requestId.length<8||!record(input.modes))throw agentTaskFailure('AGENT_TASK_INVALID');
      const old=journal.policy();if(old.modes.paid!=='direct'&&input.modes.paid==='direct'&&input.acknowledgePaid!==true)throw agentTaskFailure('AGENT_TASK_APPROVAL_REQUIRED');
      return journal.updatePolicy({revision:input.expectedRevision??input.revision,...(input.stepLimit===undefined?{}:{stepLimit:input.stepLimit}),modes:input.modes} as Parameters<AgentTaskJournal['updatePolicy']>[0],input.requestId);
    },
    close(){if(closed)return;closed=true;removeGate();for(const entry of active.values())entry.controller.abort();},
    async drain(){while(active.size)await Promise.allSettled([...active.values()].map(entry=>entry.promise));},
  };
}
export type AgentTaskRuntime=ReturnType<typeof createAgentTaskRuntime>;
