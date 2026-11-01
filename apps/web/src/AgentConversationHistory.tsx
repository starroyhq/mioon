import React,{useLayoutEffect,useRef,useState} from 'react';
import {Input} from '@mioon/ui/components/input';
import {WorkbenchButton as Button} from '@mioon/ui/components/workbench-controls';
import type {AgentTaskConversation,AgentTaskStatus} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import {useI18n} from './i18n/I18nProvider.tsx';
import {conversationDay,conversationMatches,conversationTime} from './agent-conversations.ts';
import type {ConversationDay} from './agent-conversations.ts';
import Icon from './icons.tsx';

export interface AgentConversationHistoryProps {open:boolean;projectId:string;conversations:AgentTaskConversation[];phase:'closed'|'loading'|'ready'|'error';nextCursor:string|null;currentId:string|null;newConversation:boolean;disabled:boolean;selectionError?:boolean;onClose:()=>void;onSelect:(id:string)=>unknown;onMore:()=>unknown}
export default function AgentConversationHistory({open,projectId,conversations,phase,nextCursor,currentId,newConversation,disabled,selectionError=false,onClose,onSelect,onMore}:AgentConversationHistoryProps){
  const {t,locale}=useI18n(),[query,setQuery]=useState('');
  const search=useRef<HTMLInputElement|null>(null),loadedProject=useRef(projectId);
  useLayoutEffect(()=>{const changed=loadedProject.current!==projectId;if(changed){loadedProject.current=projectId;setQuery('');}if(open){setQuery('');search.current?.focus();}},[open,projectId]);
  if(!open)return null;
  const entries=conversations.filter(item=>conversationMatches(item.title,query,locale));
  const showNew=newConversation&&conversationMatches(t('agent.panel.newConversation'),query,locale),more=Boolean(nextCursor);
  const loadMore=()=>{if(nextCursor&&phase!=='loading'&&phase!=='error')onMore();};
  const metadata=(updatedAt:string,status:AgentTaskStatus,changeCount:number,day:ConversationDay)=>{const time=conversationTime(updatedAt,locale,day);return <span className="mio-history-meta" data-testid="agent-task-history-metadata">{time&&<><span>{time}</span><span aria-hidden="true">·</span></>}<span className="mio-history-status" data-tone={status==='completed'?'success':status==='failed'?'danger':'neutral'}><span aria-hidden="true">●</span><span>{t(`agent.task.status.${status}`)}</span></span>{changeCount>0&&<><span aria-hidden="true">·</span><span>{t('agent.conversation.changes',{count:changeCount})}</span></>}</span>;};
  return <section className="mio-history-overlay" aria-label={t('agent.conversation.title')} data-testid="agent-task-history" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}}}>
    <header><strong>{t('agent.conversation.title')}</strong><Button variant="icon" aria-label={t('agent.conversation.back')} onClick={onClose}><Icon name="close" /></Button></header>
    <div className="mio-history-search"><Icon name="search" /><Input ref={search} type="search" value={query} aria-label={t('agent.conversation.search')} placeholder={t('agent.conversation.search')} onChange={event=>setQuery(event.target.value)} /></div>
    {selectionError&&<p role="alert" className="mio-error">{t('agent.conversation.loadError')}</p>}
    <div className="mio-history-list" data-testid="agent-task-history-list" onScroll={event=>{const node=event.currentTarget;if(!query.trim()&&node.scrollHeight-node.scrollTop-node.clientHeight<48)loadMore();}}>
      {(['today','yesterday','earlier'] as ConversationDay[]).map(day=>{const group=entries.filter(item=>conversationDay(item.updatedAt)===day);if(!group.length&&!(day==='today'&&showNew))return null;return <section key={day} className="mio-history-group"><h4>{t(`agent.conversation.${day}`)}</h4>
        {day==='today'&&showNew&&<Button variant="ghost" className="mio-history-item" aria-current="page" onClick={onClose}><span className="mio-history-title">{t('agent.panel.newConversation')}</span><span className="mio-secondary">{t('agent.conversation.current')}</span></Button>}
        {group.map(item=><Button key={item.id} variant="ghost" className="mio-history-item" data-testid="agent-task-history-item" aria-current={currentId===item.id?'page':undefined} disabled={disabled} onClick={()=>onSelect(item.id)}><span className="mio-history-title" title={item.title}>{item.title}</span>{metadata(item.updatedAt,item.lastRunStatus,item.changeCount,day)}{currentId===item.id&&<span className="mio-current-conversation">{t('agent.conversation.current')}</span>}</Button>)}
      </section>;})}
      {!entries.length&&!showNew&&phase!=='loading'&&<p className="mio-secondary">{t(query?'agent.conversation.noMatch':'agent.conversation.empty')}</p>}
      {phase==='loading'&&<p role="status" className="mio-secondary">{t('agent.conversation.loading')}</p>}
      {phase==='error'&&<div role="alert"><p>{t('agent.task.error')}</p><Button variant="ghost" onClick={onMore}>{t('agent.task.reload')}</Button></div>}
      {more&&<Button variant="ghost" disabled={phase==='loading'} onClick={loadMore}>{t('agent.conversation.loadMore')}</Button>}
    </div>
  </section>;
}
