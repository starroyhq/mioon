import type {AgentTaskChange,AgentTaskDiagnostic,AgentTaskJson,AgentTaskLocale,AgentTaskNote,AgentTaskSkippedTarget,AgentTaskStep,AgentTaskTier} from '@mioon/contracts/agent-tasks-v2';
import type {AgentConfiguration} from './config.ts';
import {TASK_MODEL_LIMITS,taskContinuation,taskResponseLanguageContext} from './task-gateway-v2.ts';
import type {TaskModelOutput,TaskToolDefinition} from './task-gateway-v2.ts';
import {AGENT_TASK_TOOLS_LOAD_NAME,agentTaskToolGroupForName,loadedAgentTaskToolGroups} from './task-tool-groups-v2.ts';
import {compactTaskModelHistory} from './task-context-compaction-v2.ts';

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const bytes=(value:unknown):number=>Buffer.byteLength(JSON.stringify(value));
const attachmentInstructions:Readonly<Record<AgentTaskLocale,string>>={
  'zh-Hans':'用户为本轮选择的附件（仅可使用这些托管句柄）：',
  'zh-Hant':'使用者為本輪選取的附件（僅可使用這些代管代碼）：',
  en:'Attachments selected by the user for this run (use only these managed handles):',
  ja:'ユーザーがこのラウンドで選択した添付ファイル（これらの管理済みハンドルのみ使用可）：',
};

export interface TaskContextAttachment {handle:string;name:string;mimeType:string}
export interface TaskContextPreviousRun {
  text:string;
  notes?:readonly AgentTaskNote[];
  steps:readonly Pick<AgentTaskStep,'kind'|'status'|'result'>[];
}
export interface TaskRunContextInput {
  locale:AgentTaskLocale;
  text:string;
  /** Already scoped and selected by the journal, oldest first. */
  previousRuns?:readonly TaskContextPreviousRun[];
  attachments?:readonly TaskContextAttachment[];
}
export interface TaskRunContext {
  context:AgentTaskJson[];
  metrics:{historyBytes:number;retainedRuns:number;trimmedRuns:number};
}

/** Assemble only the host's supplied observations. Project/conversation
 * ownership and completed-run selection remain journal responsibilities. */
export function assembleRunContext({locale,text,previousRuns=[],attachments=[]}:TaskRunContextInput):TaskRunContext {
  const groups:AgentTaskJson[][]=[];
  for(const previous of previousRuns){
    const final=previous.steps.filter(step=>step.kind==='model'&&step.status==='completed').at(-1);
    if(final&&record(final.result)&&typeof final.result.text==='string')groups.push([
      {role:'user',content:previous.text},
      ...(previous.notes??[]).map(note=>({role:'user',content:note.text})),
      {role:'assistant',content:final.result.text},
    ]);
  }
  const previousCount=groups.length;
  const currentMessage:AgentTaskJson={role:'user',content:text+(attachments.length?`\n${attachmentInstructions[locale]}${JSON.stringify(attachments)}`:'')};
  let context:AgentTaskJson[]=[taskResponseLanguageContext(locale),...groups.flat(),currentMessage];
  while(groups.length&&bytes(context)>TASK_MODEL_LIMITS.historyBytes){groups.shift();context=[taskResponseLanguageContext(locale),...groups.flat(),currentMessage];}
  return {context,metrics:{historyBytes:bytes(context),retainedRuns:groups.length,trimmedRuns:previousCount-groups.length}};
}

export interface TaskModelToolSelection {steps?:readonly AgentTaskStep[];attachments?:readonly string[]}
export function selectTaskModelTools<T extends TaskToolDefinition&{risk:AgentTaskTier}>(definitions:readonly T[],diagnostic?:AgentTaskDiagnostic,{steps=[],attachments=[]}:TaskModelToolSelection={}):T[]{
  if(diagnostic){
    const original=definitions.filter(tool=>tool.name!==AGENT_TASK_TOOLS_LOAD_NAME);
    if(diagnostic.profile==='text')return [];
    if(diagnostic.profile==='read_only')return original.filter(tool=>tool.risk==='read_only');
    return diagnostic.toolNames?original.filter(tool=>diagnostic.toolNames!.includes(tool.name)):original;
  }
  const groups=new Set<string>(['core',...loadedAgentTaskToolGroups(steps)]);
  return definitions.filter(tool=>groups.has(agentTaskToolGroupForName(tool.name)??'')||attachments.length>0&&['mioon_asset_import_selected','mioon_lut_import_selected'].includes(tool.name));
}

/** Visibility belongs to the exact request that produced the response. A load
 * earlier in the same batch cannot authorize another call from that batch. */
export function sourceTaskModelToolNames(protocol:AgentConfiguration['protocol'],request:AgentTaskJson|undefined):string[]{
  const invalid=():never=>{throw Object.assign(new Error('Invalid frozen model tool catalog.'),{code:'AGENT_TASK_STORAGE_UNAVAILABLE'});};
  if(!record(request)||typeof request.body!=='string')return invalid();
  let body:unknown;try{body=JSON.parse(request.body);}catch{return invalid();}
  if(!record(body))return invalid();
  if(body.tools===undefined)return [];
  if(!Array.isArray(body.tools))return invalid();
  const names:string[]=[];
  for(const entry of body.tools){
    if(!record(entry))return invalid();
    const definition=protocol==='chat_completions'?entry.function:entry;
    if(!record(definition)||typeof definition.name!=='string'||!/^[-A-Za-z0-9_]{1,64}$/u.test(definition.name)||names.includes(definition.name))return invalid();
    if(protocol!=='anthropic_messages'&&entry.type!=='function')return invalid();
    names.push(definition.name);
  }
  return names;
}

export interface TaskModelToolResult {callId:string;result:AgentTaskJson}
export type TaskModelContextFragment=
  | {kind:'notes';notes:readonly AgentTaskNote[];modelStepId:string}
  | {kind:'discarded';modelStepId?:string}
  | {kind:'continuation';output:TaskModelOutput;results:TaskModelToolResult[];replan?:boolean;modelStepId?:string}
  | {kind:'partial';text:string;modelStepId?:string};

/** Runtime chooses each fragment only after its existing control/effect checks.
 * Protocol continuation is validated immediately, before any later tool batch. */
export function replayModelContext(protocol:AgentConfiguration['protocol'],fragment:TaskModelContextFragment):AgentTaskJson[]{
  if(fragment.kind==='notes')return fragment.notes.filter(note=>note.modelStepId===fragment.modelStepId).map(note=>({role:'user',content:note.text}));
  if(fragment.kind==='discarded')return [{role:'user',content:'上一次模型请求结果未知，用户已将其标记为失败。请重新读取当前保存状态后继续，不要假定此前有工具执行。'}];
  if(fragment.kind==='partial')return [protocol!=='responses'
    ?{role:'assistant',content:fragment.text}
    :{type:'message',role:'assistant',content:[{type:'output_text',text:fragment.text}]}];
  const messages=taskContinuation(protocol,fragment.output,fragment.results);
  if(fragment.replan)messages.push({role:'user',content:'原排队操作因目标冲突已取消。请重新读取当前保存状态后规划，不要重放旧参数或假定生成已提交。'});
  return messages;
}

export interface TaskModelInputOptions {
  context?:readonly AgentTaskJson[];
  text:string;
  fragments?:readonly (readonly AgentTaskJson[])[];
  notes?:readonly AgentTaskNote[];
  tools?:readonly TaskToolDefinition[];
  replay?:TaskModelReplayInput;
}
/** Semantic request boundaries let compaction replay its earlier decisions,
 * rather than re-optimizing an ever-growing raw transcript on every call. */
export interface TaskModelReplayInput {
  protocol:AgentConfiguration['protocol'];
  fragments:readonly TaskModelContextFragment[];
  steps?:readonly AgentTaskStep[];
  changes?:readonly AgentTaskChange[];
  skippedTargets?:readonly AgentTaskSkippedTarget[];
}

/** Base-context copies are deliberately outside the compaction path. */
export function cloneTaskBaseContext(context:readonly AgentTaskJson[]|undefined,text:string):AgentTaskJson[]{
  return structuredClone([...(context??[{role:'user',content:text}])]);
}
export interface TaskModelInput {
  history:AgentTaskJson[];
  tools:TaskToolDefinition[];
  pendingNotes:AgentTaskNote[];
  metrics:{historyBytes:number;toolCount:number};
}

/** Shared by execution and note-capacity probes. Saved intents bypass request
 * reconstruction; a probe supplies the saved history and known partial output. */
export function assembleModelInput({context,text,fragments=[],notes=[],tools=[],replay}:TaskModelInputOptions):TaskModelInput {
  let history:AgentTaskJson[]=cloneTaskBaseContext(context,text);
  for(const fragment of fragments)history.push(...fragment);
  const pendingNotes=notes.filter(note=>note.modelStepId===undefined);
  if(replay)history=compactTaskModelHistory(history,pendingNotes,replay,replayModelContext);
  else history.push(...pendingNotes.map(note=>({role:'user',content:note.text})));
  return {history,tools:[...tools],pendingNotes,metrics:{historyBytes:bytes(history),toolCount:tools.length}};
}
