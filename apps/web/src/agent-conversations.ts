import type {Locale} from '../../../packages/i18n/src/index.ts';
import type {AgentTaskStatus} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import {createAgentChatClient,safeAgentChatSnapshot,safeAgentChatHistory} from './agent-chat.ts';
import type {AgentChatRun} from './agent-chat.ts';
import {createAgentEditsClient,safeAgentEditPage} from './agent-edits.ts';
import type {AgentEditProposal} from './agent-edits.ts';

export type ConversationDay='today'|'yesterday'|'earlier';
export interface LegacyConversation {id:string;projectId:string;title:string;updatedAt:string;lastRunStatus:AgentTaskStatus;changeCount:number;runs:AgentChatRun[];proposals:AgentEditProposal[];chatCursor:string|null;editCursor:string|null;instanceId:string;threadId:string}
export function conversationDay(updatedAt:string,now=new Date()):ConversationDay {
  const date=new Date(updatedAt),day=(value:Date)=>`${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
  if(!Number.isFinite(date.getTime()))return 'earlier';if(day(date)===day(now))return 'today';
  const yesterday=new Date(now);yesterday.setDate(now.getDate()-1);return day(date)===day(yesterday)?'yesterday':'earlier';
}
export function conversationTime(updatedAt:string,locale:Locale,day:ConversationDay):string {
  const date=new Date(updatedAt);if(!Number.isFinite(date.getTime()))return '';
  return new Intl.DateTimeFormat(locale,day==='earlier'?{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}:{hour:'2-digit',minute:'2-digit'}).format(date);
}
export function conversationMatches(title:string,query:string,locale:Locale):boolean {return title.toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale));}
/** V1 keeps its own validated DTO and cursors. This adapter has no send, apply,
 * reject or recovery seam and never interprets old proposals as v2 Changes. */
export async function readLegacyConversation(projectId:string,previous:LegacyConversation|null=null):Promise<LegacyConversation|null>{
  const chatClient=createAgentChatClient(),editClient=createAgentEditsClient();
  const older=Boolean(previous),readChat=!older||Boolean(previous?.chatCursor),readEdits=!older||!readChat&&Boolean(previous?.editCursor);
  const [chatWire,editWire]=await Promise.all([readChat?(older?chatClient.history(projectId,previous!.chatCursor):chatClient.read(projectId)):Promise.resolve(null),readEdits?editClient.list(projectId,{view:'all',cursor:older?previous!.editCursor:null}):Promise.resolve(null)]);
  const chat=chatWire===null?null:older?safeAgentChatHistory(chatWire,projectId,previous!.instanceId,previous!.threadId,previous!.chatCursor):safeAgentChatSnapshot(chatWire,projectId);
  const edits=editWire===null?null:safeAgentEditPage(editWire,projectId);
  const runs=[...(previous?.runs??[])],proposals=[...(previous?.proposals??[])];
  for(const run of chat?.runs??[])if(!runs.some(item=>item.id===run.id))runs.push(run);
  for(const proposal of edits?.proposals??[])if(!proposals.some(item=>item.id===proposal.id))proposals.push(proposal);
  if(!runs.length&&!proposals.length)return null;
  runs.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  const first=runs[0],last=runs.at(-1),known=['accepted','running','paused','awaiting_approval','completed','failed','stopped','interrupted','reverted'] as const;
  const status=known.find(value=>value===last?.status)??'interrupted';
  const chatCursor=chat?.historyCursor??(readChat?null:previous?.chatCursor??null),editCursor=edits?.nextCursor??(readEdits?null:previous?.editCursor??null);
  if(older&&(readChat&&chatCursor!==null&&chatCursor===previous!.chatCursor||readEdits&&editCursor!==null&&editCursor===previous!.editCursor))throw new Error('INVALID_RESPONSE');
  return{id:chat?.threadId??previous?.id??`legacy:${projectId}`,projectId,title:Array.from((first?.userText??'').replace(/\s+/gu,' ').trim()).slice(0,80).join(''),updatedAt:last?.updatedAt??proposals.at(-1)!.updatedAt,lastRunStatus:status,changeCount:proposals.filter(item=>item.status==='applied').length,runs,proposals,chatCursor,editCursor,instanceId:chat?.instanceId??previous?.instanceId??edits!.instanceId,threadId:chat?.threadId??previous?.threadId??''};
}
