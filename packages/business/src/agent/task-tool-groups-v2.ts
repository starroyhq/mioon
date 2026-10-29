import type {AgentTaskLocale,AgentTaskStep} from '@mioon/contracts/agent-tasks-v2';

export const AGENT_TASK_TOOLS_LOAD_NAME='mioon_tools_load';
export const AGENT_TASK_TOOLS_LOAD_OPERATION='tools.load';
/** The host tool Mio asks with (C3); its step waits as `awaiting_answer`. */
export const AGENT_TASK_ASK_TOOL='mioon_ask';
export const AGENT_TASK_ASK_OPERATION='mio.ask';
/** C6 host tools: read a built-in method, and report a read-only continuity review. */
export const AGENT_TASK_SKILL_READ_TOOL='mioon_skill_read';
export const AGENT_TASK_SKILL_READ_OPERATION='skill.read';
export const AGENT_TASK_CONTINUITY_REPORT_TOOL='mioon_continuity_report';
export const AGENT_TASK_CONTINUITY_REPORT_OPERATION='continuity.report';
export const AGENT_TASK_GOAL_SET_TOOL='mioon_goal_set';
export const AGENT_TASK_GOAL_SET_OPERATION='goal.set';
/** Conversation-only host tools. Diagnostics are not shown in a conversation and
 * read no project methods, so they never receive these. */
export const AGENT_TASK_CONVERSATION_TOOLS=Object.freeze(['mioon_tools_load','mioon_ask','mioon_skill_read','mioon_continuity_report','mioon_goal_set']);
export const AGENT_TASK_TOOL_GROUP_IDS=Object.freeze(['core','canvas','subjects','assets','editing','subtitles','audio','colour','exports','video','images','scenes'] as const);
export type AgentTaskToolGroupId=typeof AGENT_TASK_TOOL_GROUP_IDS[number];
export type AgentTaskLoadableToolGroupId=Exclude<AgentTaskToolGroupId,'core'>;
export const AGENT_TASK_LOADABLE_TOOL_GROUP_IDS=Object.freeze(AGENT_TASK_TOOL_GROUP_IDS.filter((group):group is AgentTaskLoadableToolGroupId=>group!=='core'));
export const AGENT_TASK_TOOLS_LOAD_DESCRIPTIONS:Readonly<Record<AgentTaskLocale,string>>=Object.freeze({
  'zh-Hans':'修改项目前先加载本轮需要的工具组。加载只增加可见范围，不授予权限。组：canvas（画板与镜头）；subjects（主体与绑定）；assets（素材整理与所选媒体导入）；editing（时间线剪辑与格式）；subtitles（字幕编辑）；audio（响度与音频分析）；colour（LUT、调色分析与所选LUT导入）；exports（预检、渲染与导出）；video（视频生成与工作状态）；images（图片生成与结果）；scenes（视频拆解、分镜与关键帧）。',
  'zh-Hant':'修改專案前先載入本輪需要的工具組。載入只增加可見範圍，不授予權限。組：canvas（畫板與鏡頭）；subjects（主體與綁定）；assets（素材整理與所選媒體匯入）；editing（時間軸剪輯與格式）；subtitles（字幕編輯）；audio（響度與音訊分析）；colour（LUT、調色分析與所選LUT匯入）；exports（預檢、算繪與匯出）；video（影片生成與工作狀態）；images（圖片生成與結果）；scenes（影片拆解、分鏡與關鍵影格）。',
  en:'Load tool groups needed in this run before changing the project. Loading adds visibility only, never permission. Groups: canvas (canvas and shots); subjects (subjects and bindings); assets (asset organization and selected media import); editing (timeline editing and format); subtitles (subtitle editing); audio (loudness and audio analysis); colour (LUTs, colour analysis and selected LUT import); exports (preflight, rendering and export); video (video generation and jobs); images (image generation and results); scenes (scene detection, storyboard cuts and keyframes).',
  ja:'プロジェクトを変更する前に、この実行で使うツールグループを読み込んでください。読み込みは可視範囲を増やすだけで、権限を与えません。グループ：canvas（キャンバスとショット）、subjects（被写体と関連付け）、assets（素材整理と選択済みメディアの取り込み）、editing（タイムライン編集と形式）、subtitles（字幕編集）、audio（ラウドネスと音声解析）、colour（LUT、色解析と選択済みLUTの取り込み）、exports（事前検査、レンダリングと書き出し）、video（動画生成と処理状況）、images（画像生成と結果）、scenes（シーン検出、絵コンテとキーフレーム）。',
});

/** Explicit alongside the tool admission tiers: neither RPC discovery nor a
 * name prefix may silently grant a newly added tool to a group. */
export const AGENT_TASK_TOOL_GROUPS=Object.freeze({
  core:['project.inspect','asset.list','asset.inspect','shot.inspect','timeline.inspect','timeline.format.get','version.list','job.get','export.get','node.inspect','edge.inspect','task.wait','tools.load','mio.ask','skill.read','continuity.report','goal.set'],
  canvas:['shot.create','shot.update','shot.reorder','node.create','node.update','edge.create','edge.delete','reference.attach','reference.detach','version.select','project.rename','project.notes.set'],
  subjects:['subject.list','subject.version.list','subject.binding.list','subject.create','subject.version.add','subject.binding.set'],
  assets:['asset.range.get','asset.range.set','asset.disposition.list','asset.disposition.set','asset.annotation.list','asset.annotation.set','asset.waveform.get','asset.waveform.request','asset.importSelected'],
  editing:['timeline.seed','timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.rippleRemove','timeline.clip.split','timeline.clip.refreshSources','timeline.shots.append','timeline.format.set','timeline.history.get'],
  subtitles:['timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove'],
  audio:['timeline.loudness.prepare','timeline.loudness.apply','timeline.clip.loudness','timeline.export.loudness','timeline.export.samplePeak','timeline.audioPreview.plan','timeline.audioPreview.continuousPlan'],
  colour:['lut.list','lut.inspect','lut.look.inspect','timeline.colour.source.inspect','timeline.colour.image.inspect','timeline.colour.jpeg.inspect','lut.importSelected'],
  exports:['timeline.export.preflight','timeline.export.capabilities','timeline.render','export.create','export.activity.get'],
  video:['provider.list','video.connection.list','generation.submit','job.list','task.disposition.list'],
  images:['image.profile.list','image.generate','image.request.get','image.task.get','image.task.list','image.group.list','image.group.get','image.version.list','image.task.remote.get'],
  scenes:['scene.detect','scene.request.get','scene.task.get','scene.task.list','scene.result.get','timeline.clip.splitAtScenes','scene.shots.create','frame.extract','frame.request.get','frame.task.get','frame.task.list'],
} as const satisfies Readonly<Record<AgentTaskToolGroupId,readonly string[]>>);

function toolName(operation:string):string{
  if(operation==='asset.importSelected')return 'mioon_asset_import_selected';
  if(operation==='lut.importSelected')return 'mioon_lut_import_selected';
  if(operation===AGENT_TASK_ASK_OPERATION)return AGENT_TASK_ASK_TOOL;
  return `mioon_${operation.replaceAll('.','_')}`;
}
const groupedTools=AGENT_TASK_TOOL_GROUP_IDS.flatMap(group=>AGENT_TASK_TOOL_GROUPS[group].map(operation=>({group,operation,name:toolName(operation)})));
const groupByToolName=new Map(groupedTools.map(tool=>[tool.name,tool.group]));
export const agentTaskToolGroupForName=(name:string):AgentTaskToolGroupId|undefined=>groupByToolName.get(name);
export const agentTaskToolNamesForGroup=(group:AgentTaskToolGroupId):string[]=>AGENT_TASK_TOOL_GROUPS[group].map(toolName);

/** Check the actual model catalog, including host-only tools, exactly once. */
export function assertAgentTaskToolGroupCoverage(definitions:readonly {name:string;operation:string}[]):void{
  const names=new Set<string>();
  for(const definition of definitions){
    const assigned=groupedTools.filter(tool=>tool.operation===definition.operation&&tool.name===definition.name);
    if(names.has(definition.name)||assigned.length!==1)throw Error('Agent task tool grouping is incomplete or ambiguous');
    names.add(definition.name);
  }
  if(groupedTools.length!==definitions.length||groupedTools.some(tool=>!names.has(tool.name)))throw Error('Agent task tool grouping is incomplete or ambiguous');
}

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const loadable=(value:unknown):value is AgentTaskLoadableToolGroupId=>typeof value==='string'&&AGENT_TASK_LOADABLE_TOOL_GROUP_IDS.some(group=>group===value);
export const AGENT_TASK_TOOLS_LOAD_PARAMETERS=Object.freeze({
  type:'object',properties:{groups:{type:'array',items:{type:'string',enum:AGENT_TASK_LOADABLE_TOOL_GROUP_IDS},minItems:1,maxItems:AGENT_TASK_LOADABLE_TOOL_GROUP_IDS.length}},required:['groups'],additionalProperties:false,
});

/** Duplicate requests are normalized without changing catalog order. */
export function parseAgentTaskToolLoadInput(value:unknown):AgentTaskLoadableToolGroupId[]|null{
  if(!object(value)||Object.keys(value).length!==1||!Object.hasOwn(value,'groups')||!Array.isArray(value.groups)||value.groups.length<1||value.groups.length>AGENT_TASK_LOADABLE_TOOL_GROUP_IDS.length||!value.groups.every(loadable))return null;
  const selected=new Set(value.groups);
  return AGENT_TASK_LOADABLE_TOOL_GROUP_IDS.filter(group=>selected.has(group));
}

type TaskToolLoadStep=Pick<AgentTaskStep,'kind'|'status'|'toolCall'|'result'>;

/** Steps are supplied in execution order from this run. Only a completed host
 * result can expand visibility; failed, pending and model output never do.
 * Receipts bind group identities to their own call, not to today's catalog:
 * tools is historical metadata, and unknown groups may belong to a later
 * release. Invalid receipts grant nothing without faulting task storage. */
export function loadedAgentTaskToolGroups(steps:readonly TaskToolLoadStep[]):AgentTaskLoadableToolGroupId[]{
  const loaded=new Set<AgentTaskLoadableToolGroupId>();
  for(const step of steps){
    if(step.kind!=='tool'||step.status!=='completed'||step.toolCall?.name!==AGENT_TASK_TOOLS_LOAD_NAME)continue;
    const input=step.toolCall.arguments,result=step.result;
    if(!object(input)||!Array.isArray(input.groups)||!input.groups.every(group=>typeof group==='string')||!object(result)||!Array.isArray(result.groups)||!result.groups.every(group=>typeof group==='string'))continue;
    const requested=new Set(input.groups);
    if(result.groups.some(group=>!requested.has(group)))continue;
    for(const group of result.groups)if(loadable(group))loaded.add(group);
  }
  return AGENT_TASK_LOADABLE_TOOL_GROUP_IDS.filter(group=>loaded.has(group));
}
