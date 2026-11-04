import type {AgentTaskLocale,AgentTaskStep} from '@mioon/contracts/agent-tasks-v2';
import {MIO_PROJECT_MEDIA_LIST_OPERATION,MIO_PROJECT_MEDIA_LIST_TOOL} from '../../../contracts/src/mio-project-media.ts';

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
export const AGENT_TASK_CONVERSATION_TOOLS=Object.freeze(['mioon_tools_load','mioon_ask','mioon_skill_read','mioon_continuity_report','mioon_goal_set','mioon_project_rules_set']);
export const AGENT_TASK_TOOL_GROUP_IDS=Object.freeze(['core','canvas','subjects','assets','editing','subtitles','audio','colour','exports','video','images','scenes'] as const);
export type AgentTaskToolGroupId=typeof AGENT_TASK_TOOL_GROUP_IDS[number];
export type AgentTaskLoadableToolGroupId=Exclude<AgentTaskToolGroupId,'core'>;
export const AGENT_TASK_LOADABLE_TOOL_GROUP_IDS=Object.freeze(AGENT_TASK_TOOL_GROUP_IDS.filter((group):group is AgentTaskLoadableToolGroupId=>group!=='core'));
export const AGENT_TASK_TOOLS_LOAD_DESCRIPTIONS:Readonly<Record<AgentTaskLocale,string>>=Object.freeze({
  'zh-Hans':'修改项目前按名称加载本轮需要的工具。names 只能使用列出的确切工具名，不支持组名、前缀或通配符。加载只增加可见范围，不授予权限；新加载工具从下一次回复起才可调用。',
  'zh-Hant':'修改專案前按名稱載入本輪需要的工具。names 只能使用列出的完整工具名稱，不接受組名、前綴或萬用字元。載入只增加可見範圍，不授予權限；新載入工具從下一次回覆起才可呼叫。',
  en:'Load tools needed in this run by their exact listed names before changing the project. names accepts no group names, prefixes or wildcards. Loading adds visibility only, never permission; newly loaded tools may be called only in a later response.',
  ja:'プロジェクトを変更する前に、この実行で必要なツールを列挙された正確な名前で読み込んでください。names にグループ名、接頭辞、ワイルドカードは使えません。読み込みは可視範囲を増やすだけで権限を与えず、新しいツールは次の応答から呼び出せます。',
});

/** Explicit alongside the tool admission tiers: neither RPC discovery nor a
 * name prefix may silently grant a newly added tool to a group. */
export const AGENT_TASK_TOOL_GROUPS=Object.freeze({
  core:['project.inspect','asset.list','asset.inspect','shot.inspect','timeline.inspect','timeline.format.get','version.list','job.get','export.get','node.inspect','edge.inspect','task.wait','tools.load','mio.ask','skill.read','continuity.report','goal.set','project.rules.set'],
  // C8 v2: camera previs nodes live on the canvas; reading a scene is loaded with the tools that change it.
  canvas:['shot.create','shot.update','shot.reorder','node.create','node.update','edge.create','edge.delete','reference.attach','reference.detach','version.select','project.rename','previs.inspect','previs.create','previs.scene.set'],
  subjects:['subject.list','subject.version.list','subject.binding.list','subject.create','subject.version.add','subject.binding.set'],
  assets:['asset.range.get','asset.range.set','asset.disposition.list','asset.disposition.set','asset.annotation.list','asset.annotation.set','asset.waveform.get','asset.waveform.request','asset.importSelected',MIO_PROJECT_MEDIA_LIST_OPERATION],
  // A crossfade decides how two overlapping clips hand over.
  editing:['timeline.seed','timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.rippleRemove','timeline.clip.split','timeline.clip.refreshSources','timeline.shots.append','timeline.format.set','timeline.history.get','timeline.clip.crossfade'],
  subtitles:['timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove'],
  // A gain batch applies a dialogue loudness match measured with timeline.clip.loudness.
  audio:['timeline.loudness.prepare','timeline.loudness.apply','timeline.clip.loudness','timeline.export.loudness','timeline.export.samplePeak','timeline.audioPreview.plan','timeline.audioPreview.continuousPlan','timeline.clip.setGains'],
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
export type AgentTaskToolCatalogProfile='native'|'legacy';
const legacyGroupedTools=groupedTools.flatMap(tool=>tool.operation==='project.rules.set'||tool.operation===MIO_PROJECT_MEDIA_LIST_OPERATION?[]:tool.operation==='project.rename'?[tool,{group:'canvas' as const,operation:'project.notes.set',name:'mioon_project_notes_set'}]:[tool]);
const catalogTools=(profile:AgentTaskToolCatalogProfile)=>profile==='legacy'?legacyGroupedTools:groupedTools;
export const AGENT_TASK_LOADABLE_TOOL_NAMES=Object.freeze(groupedTools.filter(tool=>tool.group!=='core').map(tool=>tool.name));
export const AGENT_TASK_LEGACY_LOADABLE_TOOL_NAMES=Object.freeze(legacyGroupedTools.filter(tool=>tool.group!=='core').map(tool=>tool.name));
const loadableNames=(profile:AgentTaskToolCatalogProfile)=>profile==='legacy'?AGENT_TASK_LEGACY_LOADABLE_TOOL_NAMES:AGENT_TASK_LOADABLE_TOOL_NAMES;
export type AgentTaskToolLoadMode='names'|'groups';
export const agentTaskToolGroupForName=(name:string,profile:AgentTaskToolCatalogProfile='native'):AgentTaskToolGroupId|undefined=>catalogTools(profile).find(tool=>tool.name===name)?.group;
export const agentTaskToolNamesForGroup=(group:AgentTaskToolGroupId,profile:AgentTaskToolCatalogProfile='native'):string[]=>catalogTools(profile).filter(tool=>tool.group===group).map(tool=>tool.name);

/** Check the actual model catalog, including host-only tools, exactly once. */
export function assertAgentTaskToolGroupCoverage(definitions:readonly {name:string;operation:string}[]):void{
  const expected=catalogTools(definitions.some(tool=>tool.name==='mioon_project_rules_set')?'native':'legacy');
  const names=new Set<string>();
  for(const definition of definitions){
    const assigned=expected.filter(tool=>tool.operation===definition.operation&&tool.name===definition.name);
    if(names.has(definition.name)||assigned.length!==1)throw Error('Agent task tool grouping is incomplete or ambiguous');
    names.add(definition.name);
  }
  if(expected.length!==definitions.length||expected.some(tool=>!names.has(tool.name)))throw Error('Agent task tool grouping is incomplete or ambiguous');
}

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const loadable=(value:unknown):value is AgentTaskLoadableToolGroupId=>typeof value==='string'&&AGENT_TASK_LOADABLE_TOOL_GROUP_IDS.some(group=>group===value);
export const AGENT_TASK_TOOLS_LOAD_PARAMETERS=Object.freeze({
  type:'object',properties:{names:{type:'array',items:{type:'string',enum:AGENT_TASK_LOADABLE_TOOL_NAMES},minItems:1,maxItems:AGENT_TASK_LOADABLE_TOOL_NAMES.length}},required:['names'],additionalProperties:false,
});
export const AGENT_TASK_LEGACY_TOOLS_LOAD_PARAMETERS=Object.freeze({
  type:'object',properties:{names:{type:'array',items:{type:'string',enum:AGENT_TASK_LEGACY_LOADABLE_TOOL_NAMES},minItems:1,maxItems:AGENT_TASK_LEGACY_LOADABLE_TOOL_NAMES.length}},required:['names'],additionalProperties:false,
});

/** Current requests load only exact non-core names. Groups remain a separate
 * legacy parser: accepting both shapes here would bypass the frozen schema. */
export function parseAgentTaskToolNameLoadInput(value:unknown,profile:AgentTaskToolCatalogProfile='native'):string[]|null{
  const available=loadableNames(profile);
  if(!object(value)||Object.keys(value).length!==1||!Array.isArray(value.names)||value.names.length<1||value.names.length>available.length||!value.names.every(name=>typeof name==='string'&&available.includes(name)))return null;
  const selected=new Set(value.names);
  return available.filter(name=>selected.has(name));
}

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

/** Names receipts bind only their own requested subset. Retired names may stay
 * in historical JSON, but never become visible. Legacy group receipts keep
 * their original meaning; their `tools` metadata is not authority. Project
 * directory reads require a completed exact-name load, never an old group. */
export function loadedAgentTaskToolNames(steps:readonly TaskToolLoadStep[],profile:AgentTaskToolCatalogProfile='native'):string[]{
  const available=loadableNames(profile);
  const groups=new Set(loadedAgentTaskToolGroups(steps));
  const loaded=new Set(catalogTools(profile).filter(tool=>tool.group!=='core'&&groups.has(tool.group)&&tool.name!==MIO_PROJECT_MEDIA_LIST_TOOL).map(tool=>tool.name));
  for(const step of steps){
    if(step.kind!=='tool'||step.status!=='completed'||step.toolCall?.name!==AGENT_TASK_TOOLS_LOAD_NAME)continue;
    const input=step.toolCall.arguments,result=step.result;
    if(!object(input)||Object.keys(input).length!==1||!Array.isArray(input.names)||!input.names.length||!input.names.every(name=>typeof name==='string')||!object(result)||Object.keys(result).length!==1||!Array.isArray(result.names)||!result.names.every(name=>typeof name==='string'))continue;
    const requested=new Set(input.names);
    if(result.names.some(name=>!requested.has(name)))continue;
    for(const name of result.names)if(available.includes(name))loaded.add(name);
  }
  return available.filter(name=>loaded.has(name));
}
